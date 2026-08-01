import { and, eq } from "drizzle-orm";
import { type GoogleApis, google } from "googleapis";
import { RelationalRepository } from "@/bases";
import { config } from "@/config";
import { TTL } from "@/constants";
import { AuthMethods, EmailJobNames, EmailTemplates, UserRole } from "@/enums";
import {
	decodeBase64,
	generateAuthenticatedData,
	generateAuthId,
	generateAuthTokens,
	generateBase64,
	oauthResponsePage,
	throwBadRequestError,
	withPresignedUrl,
	withTransaction,
} from "@/helpers";
import { userCredentials } from "@/models";
import {
	getUserMapper,
	type UserModelEntry,
} from "@/modules/user-model-map";
import { CacheService, EmailQueueService } from "@/services";
import { logger } from "@/utils";

export class GoogleOAuthService {
	private static instance: GoogleOAuthService;

	private readonly emailQueueService: EmailQueueService;

	private readonly googleClient: GoogleApis;
	private readonly googleAuth: any;
	private readonly client: any;

	private readonly log = logger;

	private provider: AuthMethods = AuthMethods.GOOGLE;
	private readonly cacheService: CacheService;

	private constructor() {
		this.googleClient = google;
		this.client = this.createOAuth2Client();
		this.googleAuth = new this.googleClient.auth.OAuth2();

		this.cacheService = CacheService.getInstance();
		this.emailQueueService = EmailQueueService.getInstance();
	}

	static getInstance() {
		if (!this.instance) {
			this.instance = new GoogleOAuthService();
		}
		return this.instance;
	}

	private createOAuth2Client() {
		return new google.auth.OAuth2(
			config.google.clientId,
			config.google.clientSecret,
			this.buildRedirectUrl(),
		);
	}

	private buildRedirectUrl() {
		const base =
			config.env === "development"
				? `http://127.0.0.1:${config.server.port}`
				: `https://${config.server.serverDomain}`;
		return `${base}/api/v1/auth/google/callback`;
	}

	private resolveModelAndLabel(userType: UserRole) {
		const entry = getUserMapper()[userType as keyof ReturnType<typeof getUserMapper>];
		if (!entry) throwBadRequestError("Invalid user type.");
		return entry as UserModelEntry;
	}

	private async exchangeCodeForUserInfo(oauthClient: any, code: string) {
		const { tokens } = await oauthClient.getToken(code);
		oauthClient.setCredentials({ access_token: tokens.access_token! });
		const response = await this.googleClient
			.oauth2("v2")
			.userinfo.get({ auth: oauthClient as any });
		return { tokens, userInfo: response.data };
	}

	private buildGoogleCredentials(tokens: Record<string, any>) {
		return {
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token,
			expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : undefined,
			scope: tokens.scope,
			tokenType: tokens.token_type,
			idToken: tokens.id_token,
		};
	}

	private async finaliseSession(userData: Record<string, any>) {
		const authenticatedUser = generateAuthenticatedData(userData);
		const authId = generateAuthId(userData.id.toString());
		const gen_tokens = await generateAuthTokens(authId, userData.userType);
		await this.cacheService.set(authId, authenticatedUser, TTL.IN_30_MINUTES);
		return { user: await withPresignedUrl<any>(authenticatedUser), gen_tokens };
	}

	getUserInfoFromAccessToken = async (accessToken: string) => {
		this.googleAuth.setCredentials({ access_token: accessToken });
		const response = await this.googleClient
			.oauth2("v2")
			.userinfo.get({ auth: this.googleAuth as any });
		return response.data;
	};

	authenticate = async (userType: UserRole) => {
		return this.client.generateAuthUrl({
			access_type: "offline",
			prompt: "consent",
			scope: [
				"https://www.googleapis.com/auth/userinfo.email",
				"https://www.googleapis.com/auth/userinfo.profile",
			],
			state: generateBase64(userType),
		});
	};

	callback = async (code: string, state: string) => {
		const userType = decodeBase64(state) as UserRole;
		const { model, label, repository } = this.resolveModelAndLabel(userType);

		let tokens: any, userInfo: any;

		try {
			({ tokens, userInfo } = await this.exchangeCodeForUserInfo(
				this.client,
				code,
			));
		} catch (err) {
			this.log.error("Google OAuth token exchange failed", err);
			return oauthResponsePage({
				title: "OAuth Authentication Error",
				message: "Failed to authenticate with Google. Please try again.",
				status: "error",
				payload: { type: "oauth_error", code: "AUTHENTICATION_FAILED" },
			});
		}

		const credentialRepo = new RelationalRepository(userCredentials);
		const existingCredential = await credentialRepo.findOne(
			and(
				eq(userCredentials.provider, this.provider),
				eq(userCredentials.providerAccountId, userInfo.id),
			)!,
		);

		let user: any;
		let isNewUser = false;

		if (!existingCredential) {
			const existingUser = await repository.findOne(
				eq(model.email, userInfo.email),
			);
			if (existingUser) {
				return oauthResponsePage({
					title: "Account Not Linked",
					message: `A ${label} account with this email already exists. Please login using your email and password, then link your Google account from settings.`,
					status: "error",
					payload: { type: "oauth_error", code: "ACCOUNT_NOT_LINKED" },
				});
			}

			try {
				user = await withTransaction(async (tx) => {
					const userRepo = new RelationalRepository(model, tx);
					const credRepo = new RelationalRepository(userCredentials, tx);

					const newUser = await userRepo.create({
						firstName: userInfo.given_name!,
						lastName: userInfo.family_name!,
						email: userInfo.email!,
						avatar: userInfo.picture!,
						emailVerified: true,
						emailVerifiedAt: new Date(),
						lastLoginAt: new Date(),
					} as any);

					await credRepo.create({
						entityId: newUser.id,
						entityType: label,
						provider: this.provider,
						providerAccountId: userInfo.id!,
						tokens: this.buildGoogleCredentials(tokens),
					} as any);

					return newUser;
				});
				isNewUser = true;
			} catch (e) {
				this.log.error(
					"Error creating user during Google OAuth callback",
					e,
				);
				return oauthResponsePage({
					title: "User Creation Error",
					message:
						"An error occurred while creating your account. Please try again.",
					status: "error",
					payload: { type: "oauth_error", code: "USER_CREATION_FAILED" },
				});
			}
		} else {
			await credentialRepo.update(existingCredential.id, {
				tokens: this.buildGoogleCredentials(tokens),
			});

			user = await repository.findById(existingCredential.entityId);
			if (user) {
				await repository.update(user.id, { lastLoginAt: new Date() });
			}
		}

		const { user: sessionUser, gen_tokens } = await this.finaliseSession(user);

		if (isNewUser) {
			this.emailQueueService.add(EmailJobNames.WELCOME, {
				message: {
					to: sessionUser.email,
					subject: "Welcome to Bloom Community! 🌸",
				},
				locals: {
					name: sessionUser.firstName,
					dashboardUrl: `${config.server.rootDomain}/dashboard`,
				},
				template: EmailTemplates.WELCOME,
			} as any);
		}

		return oauthResponsePage({
			title: isNewUser ? "Welcome to Bloom 😊" : "Welcome Back",
			message: `Signed in as ${sessionUser.email}`,
			status: "success",
			autoClose: true,
			payload: { type: "oauth_success", user: sessionUser, ...gen_tokens },
		});
	};
}
