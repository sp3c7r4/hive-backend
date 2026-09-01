import { eq } from "drizzle-orm";
import { config } from "@/config";
import { EmailJobNames } from "@/enums";
import { withPresignedUrl } from "@/helpers/storage.helper";
import { throwBadRequestError, throwNotFoundError } from "@/helpers/errors";
import type { IAuthData } from "@/interfaces";
import { UserRepository } from "@/modules/user/user.repository";
import { UserRoleRepository } from "@/modules/user/user-role.repository";
import { user_roles, users } from "@/db/postgres.schema";
import { instructorProfiles } from "@/modules/instructor/instructor.model";
import { studentProfiles } from "@/modules/student/student.model";
import { parentProfiles, parentChildLinks } from "@/modules/parent/parent.model";
import { RelationalRepository } from "@/bases/repositories";
import { EncryptionService } from "@/services/encryption.service";
import { EmailQueueService } from "@/services/queues/email.queue.service";
import { CacheService } from "@/services/cache.service";

export class UserService {
	private static instance: UserService;

	private readonly userRepo = UserRepository.getInstance();
	private readonly userRoleRepo = UserRoleRepository.getInstance();
	private readonly encryptionService = EncryptionService.getInstance();
	private readonly emailQueueService = EmailQueueService.getInstance();
	private readonly cacheService = CacheService.getInstance();

	static getInstance() {
		if (!this.instance) this.instance = new UserService();
		return this.instance;
	}

	private constructor() {}

	profile = async (authData: IAuthData) => {
		const user = await this.userRepo.findById(Number(authData.id));
		if (!user) throwNotFoundError("User not found.");

		const roles = await this.userRoleRepo.findMany(
			eq(user_roles.userId, Number(authData.id)),
		);

		return withPresignedUrl<any>({
			...user,
			roles: roles.map((r) => r.role),
		}, "avatarUrl");
	};

	update = async (authData: IAuthData, data: Record<string, any>) => {
		const userId = Number(authData.id);
		const user = await this.userRepo.findById(userId);
		if (!user) throwNotFoundError("User not found.");

		const updates: Record<string, any> = {};

		if (data.firstName !== undefined) updates.firstName = data.firstName;
		if (data.lastName !== undefined) updates.lastName = data.lastName;
		if (data.phone !== undefined) updates.phone = data.phone;
		if (data.bio !== undefined) updates.bio = data.bio;
		if (data.preferences !== undefined) {
			const existing = (user as any).preferences ?? {};
			updates.preferences = { ...existing, ...data.preferences };
		}

		const updated = await this.userRepo.update(userId, updates as any);

		const roles = await this.userRoleRepo.findMany(eq(user_roles.userId, userId));

		return withPresignedUrl<any>({
			...updated,
			roles: roles.map((r) => r.role),
		}, "avatarUrl");
	};

	onboard = async (authData: IAuthData, data: Record<string, any>) => {
		const userId = Number(authData.id);

		const user = await this.userRepo.findById(userId);
		if (!user) throwNotFoundError("User not found.");
		if (user!.onboarded) throwBadRequestError("User already onboarded.");

		const userRoles = await this.userRoleRepo.findMany(eq(user_roles.userId, userId));
		const primaryRole = userRoles[0]?.role;
		if (!primaryRole) throwBadRequestError("No role assigned. Please select a role first.");

		/* Merge notification preferences */
		const existingPrefs = ((user as any).preferences ?? {}) as Record<string, any>;
		if (data.notifications) {
			existingPrefs.notifications = {
				...existingPrefs.notifications,
				...data.notifications,
			};
		}

		/* Common updates */
		const userUpdates: Record<string, any> = {
			onboarded: true,
			preferences: existingPrefs,
		};
		if (data.avatarUrl) userUpdates.avatarUrl = data.avatarUrl;
		if (data.bio !== undefined) userUpdates.bio = data.bio;

		await this.userRepo.update(userId, userUpdates as any);

		/* Role-specific profile updates */
		if (primaryRole === "instructor") {
			if (data.specializationTags) {
				await new RelationalRepository(instructorProfiles).updateWhere(
					eq(instructorProfiles.userId, userId),
					{ specializationTags: data.specializationTags } as any,
				);
			}
		} else if (primaryRole === "student") {
			if (data.interestTags) {
				await new RelationalRepository(studentProfiles).updateWhere(
					eq(studentProfiles.userId, userId),
					{ interestTags: data.interestTags } as any,
				);
			}
		} else if (primaryRole === "parent") {
			if (data.childEmail) {
				const child = await this.userRepo.findOne(eq(users.email, data.childEmail));
				if (child) {
					await new RelationalRepository(parentChildLinks).create({
						parentId: userId,
						studentId: child.id,
						status: "active",
					} as any);

					this.emailQueueService.add(EmailJobNames.CHILD_LINKED as any, {
						message: {
							to: user!.email,
							subject: `${child.firstName} has been linked to your account`,
						},
						template: "child-linked" as any,
						locals: {
							isActive: true,
							parentName: user!.firstName,
							childName: child.firstName,
							childEmail: child.email,
							linkedAt: new Date().toLocaleDateString("en-US", {
								year: "numeric", month: "long", day: "numeric",
							}),
							dashboardUrl: `${config.server.rootDomain}/dashboard`,
						},
					});
				} else {
					await new RelationalRepository(parentChildLinks).create({
						parentId: userId,
						linkedEmail: data.childEmail,
						status: "pending",
					} as any);

					this.emailQueueService.add(EmailJobNames.CHILD_LINKED as any, {
						message: {
							to: user!.email,
							subject: `Invitation sent to ${data.childEmail}`,
						},
						template: "child-linked" as any,
						locals: {
							isActive: false,
							parentName: user!.firstName,
							childEmail: data.childEmail,
							dashboardUrl: `${config.server.rootDomain}/dashboard`,
						},
					});
				}
			}
		}

		const updatedUser = await this.userRepo.findById(userId);
		const roles = await this.userRoleRepo.findMany(eq(user_roles.userId, userId));

		return withPresignedUrl<any>({
			...updatedUser,
			roles: roles.map((r) => r.role),
		}, "avatarUrl");
	};

	updateAvatar = async (authData: IAuthData, avatarKey: string) => {
		const userId = Number(authData.id);
		const updated = await this.userRepo.update(userId, { avatarUrl: avatarKey } as any);
		if (!updated) throwNotFoundError("User not found.");

		/* Update cached session so avatar is reflected immediately */
		await this.cacheService.set(authData.authId, updated, 1800);

		return withPresignedUrl<any>(updated, "avatarUrl");
	};

	updatePassword = async (authData: IAuthData, currentPassword: string, newPassword: string) => {
		const userId = Number(authData.id);
		const user = await this.userRepo.findById(userId);
		if (!user) throwNotFoundError("User not found.");

		const isValid = await this.encryptionService.compare(
			currentPassword,
			(user as any).passwordHash!,
		);
		if (!isValid) throwBadRequestError("Current password is incorrect.");

		const newHash = await this.encryptionService.hash(newPassword);
		await this.userRepo.update(userId, { passwordHash: newHash } as any);

		/* Preserve current session, kill all other auth + refresh entries */
		await this.invalidateOtherTokens(authData);
	};

	/** @info - Admin user actions: suspend / unsuspend / delete / restore.
	 * Suspension + deletion invalidate the user's sessions immediately. */
	adminAction = async (userId: number, action: string) => {
		/* @info - includeDeleted: restore must see soft-deleted users */
		const user = await this.userRepo.findById(userId, { includeDeleted: true });
		if (!user) throwNotFoundError("User not found.");

		if (action === "suspend") {
			await this.userRepo.update(userId, { suspendedAt: new Date() } as any);
		} else if (action === "unsuspend") {
			await this.userRepo.update(userId, { suspendedAt: null } as any);
		} else if (action === "delete") {
			await this.userRepo.update(userId, { deletedAt: new Date() } as any);
		} else if (action === "restore") {
			await this.userRepo.update(userId, { deletedAt: null, suspendedAt: null } as any, {
				includeDeleted: true,
			});
		} else {
			throwBadRequestError("Unknown action");
		}

		if (action === "suspend" || action === "delete") {
			await this.invalidateAllTokens(userId);
		}

		return this.userRepo.findById(userId);
	};

	deleteAccount = async (authData: IAuthData) => {
		const userId = Number(authData.id);
		const updated = await this.userRepo.update(userId, {
			deletedAt: new Date(),
		} as any);
		if (!updated) throwNotFoundError("User not found.");

		await this.cacheService.delete(authData.authId);
		await this.invalidateAllTokens(authData.id);
	};

	private invalidateAllTokens = async (userId: string | number) => {
		const patterns = [`refresh:${userId}-*`, `auth:${userId}-*`];
		for (const pattern of patterns) {
			let cursor = "0";
			do {
				const [nextCursor, keys] = await this.cacheService.redis.scan(
					cursor, "MATCH", pattern, "COUNT", 100,
				);
				cursor = nextCursor;
				if (keys.length > 0) await this.cacheService.redis.del(...keys);
			} while (cursor !== "0");
		}
	};

	private invalidateOtherTokens = async (authData: IAuthData) => {
		const userId = authData.id;
		const currentAuthKey = authData.authId;

		/* Kill other auth sessions */
		const authPattern = `auth:${userId}-*`;
		let cursor = "0";
		do {
			const [nextCursor, keys] = await this.cacheService.redis.scan(
				cursor, "MATCH", authPattern, "COUNT", 100,
			);
			cursor = nextCursor;
			const toDelete = keys.filter((k) => k !== currentAuthKey);
			if (toDelete.length > 0) await this.cacheService.redis.del(...toDelete);
		} while (cursor !== "0");

		/* Kill other refresh tokens — skip the one whose value === current authKey */
		const refreshPattern = `refresh:${userId}-*`;
		cursor = "0";
		do {
			const [nextCursor, keys] = await this.cacheService.redis.scan(
				cursor, "MATCH", refreshPattern, "COUNT", 100,
			);
			cursor = nextCursor;
			for (const key of keys) {
				const value = await this.cacheService.redis.get(key);
				if (value !== currentAuthKey) {
					await this.cacheService.redis.del(key);
				}
			}
		} while (cursor !== "0");
	};
}
