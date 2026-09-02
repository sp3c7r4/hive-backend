import { and, eq } from "drizzle-orm";
import { type GoogleApis, google } from "googleapis";
import { RelationalRepository } from "@/bases";
import { config } from "@/config";
import { TTL } from "@/constants";
import {
	AuthMethods,
	EmailJobNames,
	EmailTemplates,
	type UserRole,
} from "@/enums";
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
import { users } from "@/modules/user/user.model";
import { UserRepository } from "@/modules/user/user.repository";
import { user_roles } from "@/modules/user/user-role.model";
import { UserRoleRepository } from "@/modules/user/user-role.repository";
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
			expiryDate: tokens.expiry_date
				? new Date(tokens.expiry_date).toISOString()
				: undefined,
			scope: tokens.scope,
			tokenType: tokens.token_type,
			idToken: tokens.id_token,
		};
	}

	private async finaliseSession(
		userData: Record<string, any>,
		userType: string,
	) {
		const authenticatedUser = generateAuthenticatedData(userData);
		const authId = generateAuthId(userData.id.toString());
		const gen_tokens = await generateAuthTokens(authId, userType);
		await this.cacheService.set(authId, authenticatedUser, TTL.IN_30_MINUTES);
		return {
			user: await withPresignedUrl<any>(authenticatedUser, "avatarUrl"),
			gen_tokens,
		};
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

		const userRepo = UserRepository.getInstance();
		const userRoleRepo = UserRoleRepository.getInstance();

		let user: any;
		let isNewUser = false;

		if (!existingCredential) {
			const existingUser = await userRepo.findOne(
				eq(users.email, userInfo.email),
			);
			if (existingUser) {
				/* @info - Origin-locked: a password/OTP account can never sign in via OAuth */
				const hasOAuth = await credentialRepo.findOne(
					eq(userCredentials.userId, existingUser.id),
				);
				if (!hasOAuth) {
					return oauthResponsePage({
						title: "Sign in with Email",
						message:
							"This account was created with email and password. Please sign in using your email.",
						status: "error",
						payload: { type: "oauth_error", code: "WRONG_LOGIN_METHOD" },
					});
				}

				/* OAuth account: upsert this provider's credential and log in */
				const existingProvider = await credentialRepo.findOne(
					and(
						eq(userCredentials.provider, this.provider),
						eq(userCredentials.userId, existingUser.id),
					)!,
				);
				if (existingProvider) {
					await credentialRepo.update(existingProvider.id, {
						tokens: this.buildGoogleCredentials(tokens),
					});
				} else {
					await credentialRepo.create({
						userId: existingUser.id,
						role: userType,
						provider: this.provider,
						providerAccountId: userInfo.id!,
						tokens: this.buildGoogleCredentials(tokens),
					} as any);
				}
				user = existingUser;
			}
			try {
				user = await withTransaction(async (tx) => {
					const uRepo = new RelationalRepository(users, tx);
					const cRepo = new RelationalRepository(userCredentials, tx);
					const urRepo = new RelationalRepository(user_roles, tx);

					const newUser = await uRepo.create({
						firstName: userInfo.given_name!,
						lastName: userInfo.family_name!,
						email: userInfo.email!,
						avatarUrl: userInfo.picture!,
						emailVerified: true,
						emailVerifiedAt: new Date(),
						lastLoginAt: new Date(),
					} as any);

					await cRepo.create({
						userId: newUser.id,
						role: userType,
						provider: this.provider,
						providerAccountId: userInfo.id!,
						tokens: this.buildGoogleCredentials(tokens),
					} as any);

					await urRepo.create({
						userId: newUser.id,
						role: userType,
					} as any);

					return newUser;
				});
				isNewUser = true;
			} catch (e) {
				this.log.error("Error creating user during Google OAuth callback", e);
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

			user = await userRepo.findById(existingCredential.userId);
			if (user) {
				await userRepo.update(user.id, { lastLoginAt: new Date() });
			}
		}

		const { user: sessionUser, gen_tokens } = await this.finaliseSession(
			user,
			userType,
		);

		if (isNewUser) {
			this.emailQueueService.add(EmailJobNames.WELCOME, {
				message: {
					to: sessionUser.email,
					subject: "Welcome to Hive Community! 🌸",
				},
				locals: {
					name: sessionUser.firstName,
					dashboardUrl: `${config.server.rootDomain}/dashboard`,
				},
				template: EmailTemplates.WELCOME,
			} as any);
		}

		return oauthResponsePage({
			title: isNewUser ? "Welcome to Hive 😊" : "Welcome Back",
			message: `Signed in as ${sessionUser.email}`,
			status: "success",
			autoClose: true,
			payload: { type: "oauth_success", user: sessionUser, ...gen_tokens },
		});
	};
}
