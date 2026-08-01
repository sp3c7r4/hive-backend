import { eq } from "drizzle-orm";
import { config } from "@/config";
import { TTL } from "@/constants";
import { EmailJobNames } from "@/enums";
import { JwtAction } from "@/enums/auth/auth.enums";
import {
	generateAuthenticatedData,
	generateAuthId,
	generateAuthTokens,
	generateOTP,
	generateOTPId,
	grabUserIdFromAuthId,
	throwBadRequestError,
	throwNotFoundError,
	throwUnauthorizedError,
	withPresignedUrl,
} from "@/helpers";
import type { IAuthData } from "@/interfaces";
import {
	CacheService,
	EmailQueueService,
	EncryptionService,
	JwtService,
} from "@/services";
import type { ILoginDataWithMetadata, ISignupDataWithMetadata } from "@/shared";
import { getUserMapper } from "@/modules/user-model-map";

export class AuthService {
	private static instance: AuthService;

	private readonly emailQueueService: EmailQueueService;
	private readonly jwtService: JwtService;
	private readonly encryptionService: EncryptionService;
	private readonly cacheService: CacheService;

	static getInstance(): AuthService {
		if (!this.instance) {
			this.instance = new AuthService();
		}
		return this.instance;
	}

	constructor() {
		this.cacheService = CacheService.getInstance();
		this.emailQueueService = EmailQueueService.getInstance();
		this.jwtService = JwtService.getInstance();
		this.encryptionService = EncryptionService.getInstance();
	}

	private resolveModel(role: string) {
		const mapper = getUserMapper();
		const entry = mapper[role as keyof typeof mapper];
		if (!entry) throwBadRequestError(`Invalid role: ${role}`);
		return entry;
	}

	signup = async (data: ISignupDataWithMetadata) => {
		const { model, repository } = this.resolveModel(data.role);

		const existing = await repository.findOne(eq(model.email, data.email));
		if (existing) throwBadRequestError("Email already exists");

		const authId = generateAuthId();
		const otpId = generateOTPId();
		const otp = generateOTP();

		const cacheData = {
			authId,
			otpId,
			firstName: data.firstName,
			lastName: data.lastName,
			email: data.email,
			action: JwtAction.VERIFY_EMAIL,
			role: data.role,
			password: this.encryptionService.encrypt(data.password),
		};

		await Promise.all([
			this.cacheService.set(authId, cacheData, TTL.IN_30_MINUTES),
			this.cacheService.set(
				otpId,
				{ otp: this.encryptionService.encrypt(otp) },
				TTL.IN_30_MINUTES,
			),
		]);

		this.emailQueueService.add(EmailJobNames.VERIFY_OTP as any, {
			message: {
				to: data.email,
				subject: "Verify your email",
			},
			template: "verify-otp" as any,
			locals: {
				otp,
				name: data.firstName,
				expiryMinutes: TTL.IN_30_MINUTES / 60,
				timestamp: new Date().toISOString(),
				ipAddress: data.ipAddress,
				location: data.location,
				device: data.userAgent,
			},
		});

		const token = this.jwtService.generateToken(authId);
		return { token };
	};

	login = async (data: ILoginDataWithMetadata) => {
		const { email, password } = data;
		const mapper = getUserMapper();

		/** @info - Try each role table to find the user */
		let foundUser: any = null;
		let foundRole: string | null = null;

		for (const [role, entry] of Object.entries(mapper)) {
			const user = await entry.repository.findOne(eq(entry.model.email, email));
			if (user) {
				foundUser = user;
				foundRole = role;
				break;
			}
		}

		if (!foundUser || foundUser.deletedAt)
			throwNotFoundError("Invalid email or password");

		const isPasswordValid = await this.encryptionService.compare(
			password,
			foundUser.hash!,
		);
		if (!isPasswordValid) throwUnauthorizedError("Invalid email or password");

		const authId = generateAuthId(foundUser.id);
		const { hash: _, ...sanitized } = foundUser;
		const authenticatedUser = generateAuthenticatedData(sanitized);

		await this.cacheService.set(authId, authenticatedUser, TTL.IN_30_MINUTES);

		await this.resolveModel(foundRole!).repository.update(foundUser.id, {
			lastLoginAt: new Date(),
		} as any);

		const tokens = await generateAuthTokens(authId, foundRole as any);

		return {
			message: "Login successful",
			user: await withPresignedUrl<any>(authenticatedUser),
			...tokens,
		};
	};

	refresh = async (refreshToken: string) => {
		const { authId, refreshId, userType } =
			this.jwtService.verifyToken(refreshToken);
		if (!refreshId) throwUnauthorizedError("Invalid refresh token.");

		const exists = await this.cacheService.redis.exists(refreshId);
		if (!exists) throwBadRequestError("Refresh token expired.");

		await this.cacheService.delete(refreshId);

		let userData = await this.cacheService.get<IAuthData>(authId);

		if (!userData) {
			const userId = grabUserIdFromAuthId(authId);
			const { repository } = this.resolveModel(userType);

			const user = await repository.findById(Number(userId));
			if (!user) throwUnauthorizedError("User not found.");

			const { hash: _, ...sanitized } = user as any;
			userData = {
				...generateAuthenticatedData(sanitized),
				authId,
				action: JwtAction.AUTHENTICATE,
			} as IAuthData;

			await this.cacheService.set(authId, userData, TTL.IN_30_MINUTES);
		}

		return generateAuthTokens(authId, userType);
	};

	logout = async (refreshToken: string) => {
		const { refreshId, authId } = this.jwtService.verifyToken(refreshToken);
		if (refreshId) {
			await this.cacheService.deleteMany([refreshId, authId]);
		}
	};

	logoutAll = async (refreshToken: string) => {
		const { refreshId, authId } = this.jwtService.verifyToken(refreshToken);
		if (!refreshId) return;

		const userId = grabUserIdFromAuthId(authId);
		const patterns = [`refresh:${userId}-*`, `auth:${userId}-*`];

		for (const pattern of patterns) {
			let cursor = "0";
			do {
				const [nextCursor, keys] = await this.cacheService.redis.scan(
					cursor,
					"MATCH",
					pattern,
					"COUNT",
					100,
				);
				cursor = nextCursor;
				if (keys.length > 0) {
					await this.cacheService.redis.del(...keys);
				}
			} while (cursor !== "0");
		}
	};

	verifyEmail = async (data: IAuthData, otpCode: string) => {
		const { authId, otpId, action, ...rest } = data;

		if (!action) throwBadRequestError("Invalid request action.");

		const cachedOtp = (await this.cacheService.get(otpId!)) as { otp: string };
		if (!cachedOtp)
			throwBadRequestError("Invalid or expired verification link.");

		if (this.encryptionService.decrypt(cachedOtp.otp) !== otpCode) {
			throwBadRequestError("Invalid code. Please try again.");
		}

		const role = (rest as any).role;
		const { repository } = this.resolveModel(role);
		let user: any = null;

		if (action === JwtAction.VERIFY_EMAIL) {
			const { firstName, lastName, email } = rest;
			const decryptedPassword = this.encryptionService.decrypt((rest as any).password!);

			const hashedPassword = await this.encryptionService.hash(decryptedPassword);

			user = await repository.create({
				firstName,
				lastName,
				email,
				hash: hashedPassword,
				role,
				emailVerified: true,
				emailVerifiedAt: new Date(),
			} as any);
		} else if (action === JwtAction.AUTHENTICATE) {
			const { repository: repo, model } = this.resolveModel(role);
			user = await repo.findOne(eq(model.email, (rest as any).email));
			if (user) {
				user = await repo.update(user.id, { lastLoginAt: new Date() });
			}
		} else if (action === JwtAction.FORGOT_PASSWORD) {
			const { email } = rest;
			const { repository: repo, model } = this.resolveModel(role);
			user = await repo.findOne(eq(model.email, email));
			if (!user) throwNotFoundError("User not found.");

			const newAuthId = generateAuthId(user.id.toString());
			const accessToken = this.jwtService.generateToken(newAuthId);

			await this.cacheService.deleteMany([otpId!, authId]);
			await this.cacheService.set(
				newAuthId,
				{
					...generateAuthenticatedData(user),
					authId: newAuthId,
					action: JwtAction.FORGOT_PASSWORD,
				},
				TTL.IN_30_MINUTES,
			);

			return { accessToken };
		} else {
			throwBadRequestError("Invalid verification action.");
		}

		if (!user) throwBadRequestError("User not found.");

		const { hash: _, ...sanitized } = user;
		const authenticatedUser = generateAuthenticatedData(sanitized);

		if (action === JwtAction.VERIFY_EMAIL) {
			this.emailQueueService.add(EmailJobNames.WELCOME as any, {
				message: {
					to: authenticatedUser.email,
					subject: "Welcome to Hive! 🐝",
				},
				template: "welcome",
				locals: {
					name: authenticatedUser.firstName,
					dashboardUrl: `${config.server.rootDomain}/dashboard`,
				},
			});
		}

		const newAuthId = generateAuthId(user.id.toString());

		await this.cacheService.deleteMany([otpId!, authId]);
		await this.cacheService.set(
			newAuthId,
			authenticatedUser,
			TTL.IN_30_MINUTES,
		);

		const tokens = await generateAuthTokens(newAuthId, role);

		return { user: await withPresignedUrl<any>(authenticatedUser), ...tokens };
	};

	forgotPassword = async (
		email: string,
		metadata: { ipAddress: string; location: string; userAgent: string },
	) => {
		const mapper = getUserMapper();

		/** @info - Find which role table the email belongs to */
		let foundUser: any = null;
		let foundRole: string | null = null;

		for (const [role, entry] of Object.entries(mapper)) {
			const user = await entry.repository.findOne(eq(entry.model.email, email));
			if (user) {
				foundUser = user;
				foundRole = role;
				break;
			}
		}

		if (!foundUser) throwNotFoundError("No account found with this email.");

		const authId = generateAuthId(foundUser.id.toString());
		const otpId = generateOTPId(foundUser.id.toString());
		const otp = generateOTP();

		const cacheData = {
			authId,
			otpId,
			email: foundUser.email,
			action: JwtAction.FORGOT_PASSWORD,
			role: foundRole,
		};

		await Promise.all([
			this.cacheService.set(authId, cacheData, TTL.IN_30_MINUTES),
			this.cacheService.set(
				otpId,
				{ otp: this.encryptionService.encrypt(otp) },
				TTL.IN_30_MINUTES,
			),
		]);

		this.emailQueueService.add(EmailJobNames.RESET_PASSWORD as any, {
			message: {
				to: foundUser.email,
				subject: "Reset your password",
			},
			template: "reset-password",
			locals: {
				otp,
				name: foundUser.firstName,
				expiryMinutes: TTL.IN_30_MINUTES / 60,
				timestamp: new Date().toISOString(),
				ipAddress: metadata.ipAddress,
				location: metadata.location,
				device: metadata.userAgent,
			},
		});

		const accessToken = this.jwtService.generateToken(authId);
		return { accessToken };
	};

	private invalidateAllTokens = async (userId: string) => {
		const patterns = [`refresh:${userId}-*`, `auth:${userId}-*`];

		for (const pattern of patterns) {
			let cursor = "0";
			do {
				const [nextCursor, keys] = await this.cacheService.redis.scan(
					cursor,
					"MATCH",
					pattern,
					"COUNT",
					100,
				);
				cursor = nextCursor;
				if (keys.length > 0) {
					await this.cacheService.redis.del(...keys);
				}
			} while (cursor !== "0");
		}
	};

	resetPassword = async (authData: IAuthData, newPassword: string) => {
		const role = (authData as any).role;
		const { repository } = this.resolveModel(role);

		const user = await repository.findById(Number(authData.id));
		if (!user) throwNotFoundError("User not found.");

		const hashedPassword = await this.encryptionService.hash(newPassword);
		await repository.update(user.id, {
			hash: hashedPassword,
			passwordChangedAt: new Date(),
		} as any);

		this.invalidateAllTokens(user.id.toString());
	};

	me = async (authData: IAuthData) => {
		const role = authData.userType;
		const { repository } = this.resolveModel(role);

		const user = await repository.findById(Number(authData.id));
		if (!user) throwNotFoundError("User not found.");

		const { hash: _, password: __, ...sanitized } = user as any;

		return withPresignedUrl<any>(sanitized);
	};
}
