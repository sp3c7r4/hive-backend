import { eq } from "drizzle-orm";
import { RelationalRepository } from "@/bases/repositories";
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
import { users } from "@/modules/user/user.model";
import { UserRepository } from "@/modules/user/user.repository";
import { user_roles } from "@/modules/user/user-role.model";
import { UserRoleRepository } from "@/modules/user/user-role.repository";
import { instructorProfiles } from "@/modules/instructor/instructor.model";
import { studentProfiles } from "@/modules/student/student.model";
import { parentProfiles } from "@/modules/parent/parent.model";

export class AuthService {
	private static instance: AuthService;

	private readonly emailQueueService: EmailQueueService;
	private readonly jwtService: JwtService;
	private readonly encryptionService: EncryptionService;
	private readonly cacheService: CacheService;
	private readonly userRepo: UserRepository;
	private readonly userRoleRepo: UserRoleRepository;

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
		this.userRepo = UserRepository.getInstance();
		this.userRoleRepo = UserRoleRepository.getInstance();
	}

	signup = async (data: ISignupDataWithMetadata) => {
		const existing = await this.userRepo.findOne(eq(users.email, data.email));
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

		const user = await this.userRepo.findOne(eq(users.email, email));
		if (!user) throwNotFoundError("Invalid email or password");

		const userAny = user as any;
		if (userAny.deletedAt) throwNotFoundError("Invalid email or password");

		if (!userAny.passwordHash)
			throwUnauthorizedError(
				"This account uses OAuth. Please sign in with Google or Facebook.",
			);

		const isPasswordValid = await this.encryptionService.compare(
			password,
			userAny.passwordHash,
		);
		if (!isPasswordValid) throwUnauthorizedError("Invalid email or password");

		const authId = generateAuthId(user!.id.toString());

		/* Get user's roles for the JWT — may be empty for new users who haven't picked a role */
		const userRoles = await this.userRoleRepo.findMany(
			eq(user_roles.userId, user!.id),
		);
		const primaryRole = userRoles[0]?.role ?? "";

		const { passwordHash: _, deleted_at: __, hash: ___, ...sanitized } = userAny;

		await this.cacheService.set(
			authId,
			{ ...sanitized, roles: userRoles.map((r) => r.role) },
			TTL.IN_30_MINUTES,
		);

		await this.userRepo.update(user!.id, {
			lastLoginAt: new Date(),
		} as any);

		const authenticatedUser = generateAuthenticatedData(sanitized);
		const tokens = await generateAuthTokens(authId, primaryRole);

		return {
			message: "Login successful",
			user: await withPresignedUrl<any>({
				...authenticatedUser,
				roles: userRoles.map((r) => r.role),
			}, "avatarUrl"),
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
			const user = await this.userRepo.findById(Number(userId));
			if (!user) throwUnauthorizedError("User not found.");

			const { passwordHash: _, deleted_at: __, ...sanitized } = user as any;
			userData = {
				...generateAuthenticatedData(sanitized),
				authId,
				action: JwtAction.AUTHENTICATE,
			} as IAuthData;

			await this.cacheService.set(authId, userData, TTL.IN_30_MINUTES);
		}

		return generateAuthTokens(authId, userType ?? "");
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

		let user: any = null;

		if (action === JwtAction.VERIFY_EMAIL) {
			const { firstName, lastName, email } = rest;
			const role = (rest as any).role;
			const decryptedPassword = this.encryptionService.decrypt(
				(rest as any).password!,
			);
			const hashedPassword = await this.encryptionService.hash(
				decryptedPassword,
			);

			/* Create user + assign their chosen role */
			user = await this.userRepo.create({
				firstName,
				lastName,
				email,
				passwordHash: hashedPassword,
				emailVerified: true,
				emailVerifiedAt: new Date(),
			} as any);

			await this.userRoleRepo.create({
				userId: user.id,
				role,
			} as any);

			/* Seed the profile row for the chosen role */
			if (role === "instructor") {
				await new RelationalRepository(instructorProfiles).create({ userId: user.id } as any);
			} else if (role === "student") {
				await new RelationalRepository(studentProfiles).create({ userId: user.id } as any);
			} else if (role === "parent") {
				await new RelationalRepository(parentProfiles).create({ userId: user.id } as any);
			}
		} else if (action === JwtAction.AUTHENTICATE) {
			user = await this.userRepo.findOne(
				eq(users.email, (rest as any).email),
			);
			if (user) {
				user = await this.userRepo.update(user.id, {
					lastLoginAt: new Date(),
				});
			}
		} else if (action === JwtAction.FORGOT_PASSWORD) {
			const { email } = rest as any;
			const foundUser = await this.userRepo.findOne(eq(users.email, email));
			if (!foundUser) throwNotFoundError("User not found.");
			user = foundUser;

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

		const userAny = user as any;
		const { passwordHash: _, deleted_at: __, ...sanitized } = userAny;
		const authenticatedUser = generateAuthenticatedData(sanitized);

		if (action === JwtAction.VERIFY_EMAIL) {
			this.emailQueueService.add(EmailJobNames.WELCOME as any, {
				message: {
					to: (authenticatedUser as any).email,
					subject: "Welcome to Hive! 🐝",
				},
				template: "welcome" as any,
				locals: {
					name: (authenticatedUser as any).firstName,
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

		const tokens = await generateAuthTokens(newAuthId, (rest as any).role ?? "");

		return {
			user: await withPresignedUrl<any>(authenticatedUser, "avatarUrl"),
			...tokens,
		};
	};

	forgotPassword = async (
		email: string,
		metadata: { ipAddress: string; location: string; userAgent: string },
	) => {
		const user = await this.userRepo.findOne(eq(users.email, email));
		if (!user) throwNotFoundError("No account found with this email.");

		const authId = generateAuthId(user!.id.toString());
		const otpId = generateOTPId(user!.id.toString());
		const otp = generateOTP();

		const cacheData = {
			authId,
			otpId,
			email: user!.email,
			action: JwtAction.FORGOT_PASSWORD,
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
				to: user!.email,
				subject: "Reset your password",
			},
			template: "reset-password" as any,
			locals: {
				otp,
				name: user!.firstName,
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

	/**
	 * @info - Called after signup. User picks their first role.
	 *         Creates a user_roles row and the corresponding profile row.
	 */
	selectRole = async (authData: IAuthData, role: string) => {
		const userId = Number(authData.id);

		/* Check user exists */
		const user = await this.userRepo.findById(userId);
		if (!user) throwNotFoundError("User not found.");

		/* Check role not already assigned — one role per user, locked */
		const existing = await this.userRoleRepo.findMany(
			eq(user_roles.userId, userId),
		);
		if (existing.length > 0) {
			throwBadRequestError(
				"A role is already assigned to this account. Each user is locked to one role.",
			);
		}

		/* Create user_roles row */
		await this.userRoleRepo.create({
			userId,
			role,
		} as any);

		/* Create profile row for the role */
		if (role === "instructor") {
			await new RelationalRepository(instructorProfiles).create({ userId } as any);
		} else if (role === "student") {
			await new RelationalRepository(studentProfiles).create({ userId } as any);
		} else if (role === "parent") {
			await new RelationalRepository(parentProfiles).create({ userId } as any);
		}

		/* Refresh the roles list */
		const roles = await this.userRoleRepo.findMany(
			eq(user_roles.userId, userId),
		);

		return {
			roles: roles.map((r) => r.role),
		};
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
		const user = await this.userRepo.findById(Number(authData.id));
		if (!user) throwNotFoundError("User not found.");

		const hashedPassword = await this.encryptionService.hash(newPassword);
		await this.userRepo.update(user!.id, {
			passwordHash: hashedPassword,
			passwordChangedAt: new Date(),
		} as any);

		this.invalidateAllTokens(user!.id.toString());
	};

	me = async (authData: IAuthData) => {
		const user = await this.userRepo.findById(Number(authData.id));
		if (!user) throwNotFoundError("User not found.");

		const roles = await this.userRoleRepo.findMany(
			eq(user_roles.userId, user!.id),
		);

		const { passwordHash: _, deleted_at: __, ...sanitized } = user! as any;

		return withPresignedUrl<any>({
			...sanitized,
			roles: roles.map((r) => r.role),
		}, "avatarUrl");
	};
}
