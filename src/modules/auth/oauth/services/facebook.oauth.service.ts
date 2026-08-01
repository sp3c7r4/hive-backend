import axios from "axios";
import { and, eq } from "drizzle-orm";
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
import type { FacebookTokenInterface, FacebookUserInfo } from "@/interfaces";
import { userCredentials } from "@/models";
import { getUserMapper } from "@/modules/user-model-map";
import { CacheService, EmailQueueService } from "@/services";
import { logger } from "@/utils";

export class FacebookOAuthService {
	private static instance: FacebookOAuthService;

	private clientId: string;
	private clientSecret: string;
	private configId: string;
	private graphApiVersion: string;

	private provider: AuthMethods = AuthMethods.FACEBOOK;

	private readonly logger = logger;
	private readonly cacheService: CacheService;
	private readonly emailQueueService: EmailQueueService;

	private constructor() {
		this.clientId = config.facebook.clientId;
		this.clientSecret = config.facebook.clientSecret;
		this.configId = config.facebook.configId;

		this.graphApiVersion = "v18.0";

		this.cacheService = CacheService.getInstance();
		this.emailQueueService = EmailQueueService.getInstance();
	}

	static getInstance() {
		if (!FacebookOAuthService.instance) {
			FacebookOAuthService.instance = new FacebookOAuthService();
		}
		return FacebookOAuthService.instance;
	}

	private buildRedirectUrl() {
		const base =
			config.env === "development"
				? `http://127.0.0.1:${config.server.port}`
				: `https://${config.server.serverDomain}`;
		return `${base}/api/v1/auth/facebook/callback`;
	}

	private resolveModelAndLabel(userType: UserRole) {
		const entry = getUserMapper()[userType as keyof ReturnType<typeof getUserMapper>];
		if (!entry) throwBadRequestError("Invalid user type.");
		return entry;
	}

	private buildFacebookCredentials(tokens: any) {
		return {
			accessToken: tokens.access_token,
			tokenType: tokens.token_type,
			expiresDate: tokens.expires_in || 0,
		};
	}

	private async exchangeCodeForUserInfo(
		code: string,
	): Promise<{ tokens: any; userInfo: FacebookUserInfo }> {
		const tokens = await this.getAccessToken(code);
		const userInfo = (await this.getUserInfoFromAccessToken(
			tokens.access_token,
		)) as FacebookUserInfo;
		return { tokens, userInfo };
	}

	private async finaliseSession(userData: Record<string, any>) {
		const authenticatedUser = generateAuthenticatedData(userData);
		const authId = generateAuthId(userData.id.toString());
		const gen_tokens = await generateAuthTokens(authId, userData.userType);
		await this.cacheService.set(authId, authenticatedUser, TTL.IN_30_MINUTES);
		return { user: await withPresignedUrl<any>(authenticatedUser), gen_tokens };
	}

	getAccessToken = async (code: string) => {
		try {
			const response = await axios.post(
				`https://graph.facebook.com/${this.graphApiVersion}/oauth/access_token`,
				{
					client_id: this.clientId,
					client_secret: this.clientSecret,
					redirect_uri: this.buildRedirectUrl(),
					code,
				},
			);

			return response.data;
		} catch (error: any) {
			this.logger.error("Facebook token exchange error:", error.response?.data);
			throwBadRequestError(
				error.response?.data?.error?.message ||
					"Failed to get Facebook access token",
			);
		}
	};

	getUserInfoFromAccessToken = async (
		accessToken: string,
	): Promise<FacebookUserInfo | undefined> => {
		try {
			const fields = "id,email,first_name,last_name,picture.type(large)";
			const response = await axios.get(
				`https://graph.facebook.com/${this.graphApiVersion}/me`,
				{
					params: {
						fields,
						access_token: accessToken,
					},
				},
			);

			const userInfo = response.data;

			if (!userInfo.email) {
				throwBadRequestError(
					"Email not provided by Facebook. Please ensure email permission is granted.",
				);
			}

			return {
				id: userInfo.id,
				email: userInfo.email,
				first_name: userInfo.first_name,
				last_name: userInfo.last_name,
				picture: userInfo.picture?.data?.url,
			};
		} catch (error: any) {
			this.logger.error("Facebook user info error:", error.response?.data);
			throwBadRequestError(
				error.response?.data?.error?.message ||
					"Failed to fetch Facebook user profile",
			);
		}
	};

	authenticate = async (userType: UserRole) => {
		const params = new URLSearchParams({
			client_id: this.clientId,
			redirect_uri: this.buildRedirectUrl(),
			config_id: this.configId,
			response_type: "code",
			state: generateBase64(userType),
			auth_type: "rerequest",
		});

		return `https://www.facebook.com/${this.graphApiVersion}/dialog/oauth?${params.toString()}`;
	};

	callback = async (code: string, state: string) => {
		const userType = decodeBase64(state) as UserRole;
		const { model, label, repository } = this.resolveModelAndLabel(userType);

		let tokens: FacebookTokenInterface,
			userInfo: FacebookUserInfo,
			user: any,
			isNewUser: boolean;

		try {
			({ tokens, userInfo } = await this.exchangeCodeForUserInfo(code));
		} catch (err: any) {
			this.logger.error("Facebook OAuth exchange failed", err);
			return oauthResponsePage({
				title: "OAuth Authentication Error",
				message: "Failed to authenticate with Facebook. Please try again.",
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

		isNewUser = false;

		if (!existingCredential) {
			const existingUser = await repository.findOne(
				eq(model.email, userInfo.email),
			);
			if (existingUser) {
				return oauthResponsePage({
					title: "Account Not Linked",
					message: `A ${label} account with this email already exists. Please login using your email and password, then link your Facebook account from settings.`,
					status: "error",
					payload: { type: "oauth_error", code: "ACCOUNT_NOT_LINKED" },
				});
			}

			try {
				user = await withTransaction(async (tx) => {
					const userRepo = new RelationalRepository(model, tx);
					const credRepo = new RelationalRepository(userCredentials, tx);

					const newUser = await userRepo.create({
						firstName: userInfo.first_name,
						lastName: userInfo.last_name,
						email: userInfo.email,
						avatar: userInfo.picture,
						emailVerified: true,
						emailVerifiedAt: new Date(),
						lastLoginAt: new Date(),
					} as any);

					await credRepo.create({
						entityId: newUser.id,
						entityType: label,
						provider: this.provider,
						providerAccountId: userInfo.id,
						tokens: this.buildFacebookCredentials(tokens),
					} as any);

					return newUser;
				});
				isNewUser = true;
			} catch (e) {
				this.logger.error(
					"Error creating user during Facebook OAuth callback",
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
				tokens: this.buildFacebookCredentials(tokens),
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
