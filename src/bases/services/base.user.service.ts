/**
 * Base user service — provides signup, login, profile, update, and delete
 * flows for any user-like model backed by a Drizzle table.
 *
 * TODO: Rewrite with generic type T bound to the actual Drizzle table type.
 * For now this is a skeleton — wire it up to your concrete user model.
 */

import { eq } from "drizzle-orm";
import { TTL } from "@/constants";
import {
	AuthLoginTypes,
	JwtAction,
	UserStatus,
	type UserTypes,
} from "@/enums";
import {
	generateAuthenticatedData,
	generateAuthTokens,
} from "@/helpers/auth/auth.helpers";
import {
	generateAuthId,
	generateOTP,
	generateOTPId,
	generateLockKey,
} from "@/helpers/id-generators";
import { throwBadRequestError, throwNotFoundError } from "@/helpers/errors";
import type {
	IAuthData,
	IAuthResponse,
	IBaseUser,
} from "@/interfaces";
import { CacheService } from "@/services/cache.service";
import { EncryptionService } from "@/services/encryption.service";
import { JwtService } from "@/services/jwt.service";
import { EmailQueueService } from "@/services/queues/email.queue.service";
import type { ILoginDataWithMetadata, ISignupDataWithMetadata } from "@/shared";
import type { RelationalRepository } from "../repositories";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type ModelLabel = string;

export class BaseUserService<T extends Record<string, any>> {
	protected readonly cacheService: CacheService = CacheService.getInstance();
	protected readonly emailQueueService: EmailQueueService;
	protected readonly jwtService: JwtService;
	protected readonly encryptionService: EncryptionService;

	protected readonly model: T;
	protected readonly repository: RelationalRepository<any>;

	constructor(
		private readonly modelName: ModelLabel,
		model: T,
		repository: RelationalRepository<any>,
	) {
		this.model = model;
		this.repository = repository;
		this.emailQueueService = EmailQueueService.getInstance();
		this.jwtService = JwtService.getInstance();
		this.encryptionService = EncryptionService.getInstance();
	}

	private throwNotFound(): never {
		return throwNotFoundError(
			`${this.modelName[0]!.toUpperCase()}${this.modelName.slice(1)} not found`,
		);
	}

	private sanitize<R extends { hash?: string | null }>(record: R): Omit<R, "hash"> {
		const { hash, ...rest } = record;
		return rest;
	}

	signup = async (data: ISignupDataWithMetadata) => {
		const findUser = await this.repository.findOne(
			eq(this.model.email, data.email),
		);
		if (findUser) throwBadRequestError("Email already exists");

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
			userType: this.modelName,
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

		this.emailQueueService.add("verify-otp", {
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
			idempotencyKey: generateLockKey(authId),
		});

		const token = this.jwtService.generateToken(authId);
		return { token };
	};

	login = async (data: ILoginDataWithMetadata) => {
		const { email, password, loginType } = data;

		let foundUser = await this.repository.findOne(eq(this.model.email, email));
		if (!foundUser || foundUser.deletedAt)
			return this.throwNotFound();

		const authId = generateAuthId(foundUser.id);

		let response: IAuthResponse = { message: "" };

		switch (loginType) {
			case AuthLoginTypes.PASSWORD: {
				if (!password) throwBadRequestError("Password is required");

				const isPasswordValid = await this.encryptionService.compare(
					password,
					foundUser.hash!,
				);
				if (!isPasswordValid) throwBadRequestError("Invalid password");

				const sanitized = this.sanitize(foundUser);
				await this.cacheService.set(authId, generateAuthenticatedData(sanitized));

				foundUser = await this.repository.update(foundUser.id, {
					lastLoginAt: new Date(),
				});

				const tokens = await generateAuthTokens(
					authId,
					(foundUser!.role ?? this.modelName) as any,
				);

				response = {
					message: "Login successful",
					user: generateAuthenticatedData(this.sanitize(foundUser!)),
					...tokens,
				};
				break;
			}
			case AuthLoginTypes.OTP: {
				const otp = generateOTP();
				const otpId = generateOTPId();

				const cacheData = {
					authId,
					otpId,
					firstName: foundUser.firstName,
					lastName: foundUser.lastName,
					email: foundUser.email,
					action: JwtAction.AUTHENTICATE,
					userType: this.modelName,
					password: this.encryptionService.encrypt(data.password),
				};

				await Promise.all([
					this.cacheService.set(authId, cacheData, TTL.IN_30_MINUTES),
					this.cacheService.set(otpId, { otp: this.encryptionService.encrypt(otp) }, TTL.IN_30_MINUTES),
				]);

				await this.emailQueueService.add("verify-otp", {
					message: { to: foundUser.email, subject: "Verify your email" },
					template: "verify-otp" as any,
					locals: {
						otp,
						expiryMinutes: TTL.IN_30_MINUTES / 60,
						name: foundUser.firstName,
						timestamp: new Date().toISOString(),
						location: data.location,
						device: data.userAgent,
						ipAddress: data.ipAddress,
					},
					idempotencyKey: generateLockKey(authId),
				});

				const token = this.jwtService.generateToken(authId);
				response = {
					message: "An otp has been sent to your email.",
					accessToken: token,
				};
				break;
			}
			default:
				throwBadRequestError("Invalid login type");
		}

		return response;
	};

	profile = async (authData: IAuthData) => {
		const user = await this.repository.findById(authData.id);
		if (!user) return this.throwNotFound();
		return this.sanitize(user);
	};

	update = async (authData: IAuthData, data: Partial<IBaseUser>, _extraFields: string[] = []) => {
		const getUser = await this.repository.findById(authData.id);
		if (!getUser) return this.throwNotFound();

		const allowedFields = ["firstName", "lastName", "phone", "bio", "preferences"];
		const filtered: Record<string, any> = {};
		for (const [key, value] of Object.entries(data)) {
			if (allowedFields.includes(key)) filtered[key] = value;
		}

		const updated = await this.repository.update(authData.id, {
			...filtered,
			preferences: { ...getUser.preferences, ...(filtered.preferences as any) },
		});
		if (!updated) return this.throwNotFound();

		const sanitized = this.sanitize(updated);
		await this.cacheService.set(authData.authId, sanitized, TTL.IN_30_MINUTES);
		return sanitized;
	};

	updatePassword = async (authData: IAuthData, oldPassword: string, newPassword: string) => {
		const foundUser = await this.repository.findById(authData.id);
		if (!foundUser) return this.throwNotFound();

		const isPasswordValid = await this.encryptionService.compare(oldPassword, foundUser.hash!);
		if (!isPasswordValid) throwBadRequestError("Invalid current password");

		const newHash = await this.encryptionService.hash(newPassword);
		await this.repository.update(authData.id, { hash: newHash });
		await this.invalidateAllTokens(authData.id);
	};

	private invalidateAllTokens = async (userId: string | number) => {
		const patterns = [`refresh:${userId}-*`, `auth:${userId}-*`];
		for (const pattern of patterns) {
			let cursor = "0";
			do {
				const [nextCursor, keys] = await this.cacheService.redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
				cursor = nextCursor;
				if (keys.length > 0) await this.cacheService.redis.del(...keys);
			} while (cursor !== "0");
		}
	};

	updateAvatar = async (authData: IAuthData, avatarKey: string) => {
		const updated = await this.repository.update(authData.id, { avatar: avatarKey });
		if (!updated) return this.throwNotFound();
		const sanitized = this.sanitize(updated);
		await this.cacheService.set(authData.authId, sanitized, TTL.IN_30_MINUTES);
		return sanitized;
	};

	delete = async (authData: IAuthData) => {
		const updated = await this.repository.update(authData.id, {
			deletedAt: new Date(),
		});
		if (!updated) return this.throwNotFound();
		await this.cacheService.delete(authData.authId);
		await this.invalidateAllTokens(authData.id);
	};
}
