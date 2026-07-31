import type { UserStatus, UserTypes } from "@/enums";
import type { IUserPreferences } from "../preferences";

export interface IBaseUser {
	id: number;
	firstName: string;
	lastName?: string;
	email: string;
	emailVerified: boolean;
	emailVerifiedAt: Date;
	lastLoginAt: Date;
	avatar: string;
	bio: string;
	phone: string;
	phoneVerified: boolean;
	userType: UserTypes;
	isAdmin: boolean;
	passwordChangedAt: Date;
	hash: string;
	onboarded: boolean;
	status: UserStatus;
	deletedAt: Date;
	preferences: IUserPreferences;
}

/** User data safe to cache/return — no sensitive fields */
export type SafeUser = Omit<IBaseUser, "hash">;
