import axios from "axios";
import { and, eq } from "drizzle-orm";
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
import type { FacebookTokenInterface, FacebookUserInfo } from "@/interfaces";
import { userCredentials } from "@/models";
import { users } from "@/modules/user/user.model";
import { UserRepository } from "@/modules/user/user.repository";
import { user_roles } from "@/modules/user/user-role.model";
import { UserRoleRepository } from "@/modules/user/user-role.repository";
import { CacheService, EmailQueueService } from "@/services";
import { logger } from "@/utils";

export class FacebookOAuthService {
	private static instance: FacebookOAuthService;

	private clientId: string;
	private clientSecret: string;
	private configId: string | undefined;
	private graphApiVersion: string;

	private provider: AuthMethods = AuthMethods.FACEBOOK;

	private readonly log = logger;
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
			this.log.error("Facebook token exchange error:", error.response?.data);
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
			this.log.error("Facebook user info error:", error.response?.data);
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
			/* @info - Classic OAuth dialog: scope declares the permissions, no config needed */
			scope: "email,public_profile",
			response_type: "code",
			state: generateBase64(userType),
			auth_type: "rerequest",
		});

		/* @info - Optional: when a Login for Business config exists it can
		 * override the permission screen; not required for the dialog. */
		if (this.configId) {
			params.set("config_id", this.configId);
		}

		return `https://www.facebook.com/${this.graphApiVersion}/dialog/oauth?${params.toString()}`;
	};

	callback = async (code: string, state: string) => {
		const userType = decodeBase64(state) as UserRole;

		let tokens: FacebookTokenInterface,
			userInfo: FacebookUserInfo,
			user: any,
			isNewUser: boolean;

		try {
			({ tokens, userInfo } = await this.exchangeCodeForUserInfo(code));
		} catch (err: any) {
			this.log.error("Facebook OAuth exchange failed", err);
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

		const userRepo = UserRepository.getInstance();
		const userRoleRepo = UserRoleRepository.getInstance();

		isNewUser = false;

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
						tokens: this.buildFacebookCredentials(tokens),
					});
				} else {
					await credentialRepo.create({
						userId: existingUser.id,
						role: userType,
						provider: this.provider,
						providerAccountId: userInfo.id,
						tokens: this.buildFacebookCredentials(tokens),
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
						firstName: userInfo.first_name,
						lastName: userInfo.last_name,
						email: userInfo.email,
						avatarUrl: userInfo.picture,
						emailVerified: true,
						emailVerifiedAt: new Date(),
						lastLoginAt: new Date(),
					} as any);

					await cRepo.create({
						userId: newUser.id,
						role: userType,
						provider: this.provider,
						providerAccountId: userInfo.id,
						tokens: this.buildFacebookCredentials(tokens),
					} as any);

					await urRepo.create({
						userId: newUser.id,
						role: userType,
					} as any);

					return newUser;
				});
				isNewUser = true;
			} catch (e) {
				this.log.error("Error creating user during Facebook OAuth callback", e);
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
