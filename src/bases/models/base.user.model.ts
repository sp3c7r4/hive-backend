import {
	boolean,
	integer,
	jsonb,
	pgEnum,
	text,
	timestamp,
	varchar,
} from "drizzle-orm/pg-core";
import type { IUserPreferences } from "@/interfaces";
import { UserRole } from "@/enums";
import { timestamps } from "@/models/timestamps.b.model";

export const userRoleEnum = pgEnum("user_role", Object.values(UserRole) as [string, ...string[]]);

/**
 * @info - Shared identity columns spread into every role table (instructors, students, parents).
 *         There is no standalone "users" table — each role table IS the user.
 */
export const BaseUser = {
	id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
	firstName: varchar("first_name", { length: 255 }).notNull(),
	lastName: varchar("last_name", { length: 255 }).notNull(),
	email: varchar("email", { length: 255 }).notNull(),
	role: userRoleEnum("role").notNull(),
	emailVerified: boolean("email_verified").default(false),
	emailVerifiedAt: timestamp("email_verified_at"),
	lastLoginAt: timestamp("last_login_at"),
	avatar: varchar("avatar", { length: 500 }),
	bio: text("bio"),
	phone: varchar("phone", { length: 50 }),
	phoneVerified: boolean("phone_verified").default(false),
	passwordChangedAt: timestamp("password_changed_at"),
	onboarded: boolean("onboarded").default(false),
	/** @info - Password hash (Argon2id) */
	hash: varchar("hash", { length: 255 }),
	preferences: jsonb("preferences")
		.$type<IUserPreferences>()
		.default({
			/** @info - light, dark, system */
			theme: "system",
			locale: "en-US",
			timezone: "UTC",
			notifications: {
				email: true,
				push: true,
				marketing: false,
				/** @info - daily, weekly, none */
				digest: "none",
			},
		}),
	...timestamps,
};
