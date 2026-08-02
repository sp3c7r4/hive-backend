import {
	boolean,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import type { IUserPreferences } from "@/interfaces";
import { TableNames } from "@/enums";
import { softDelete } from "@/models/soft-delete.model";
import { timestamps } from "@/models/timestamps.b.model";
import { user_roles } from "./user-role.model";

/**
 * @info - Single users table. Roles live in user_roles junction.
 *         Role-specific fields live in profile tables (instructor_profiles, etc.).
 */
export const users = pgTable(
	TableNames.USERS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		firstName: varchar("first_name", { length: 255 }).notNull(),
		lastName: varchar("last_name", { length: 255 }).notNull(),
		email: varchar("email", { length: 255 }).notNull(),
		passwordHash: varchar("password_hash", { length: 255 }),
		avatarUrl: varchar("avatar_url", { length: 500 }),
		bio: text("bio"),
		phone: varchar("phone", { length: 50 }),
		phoneVerified: boolean("phone_verified").default(false),
		emailVerified: boolean("email_verified").default(false),
		emailVerifiedAt: timestamp("email_verified_at"),
		lastLoginAt: timestamp("last_login_at"),
		passwordChangedAt: timestamp("password_changed_at"),
		onboarded: boolean("onboarded").default(false),
		preferences: jsonb("preferences")
			.$type<IUserPreferences>()
			.default({
				theme: "system",
				locale: "en-US",
				timezone: "UTC",
				notifications: {
					email: true,
					push: true,
					marketing: false,
					digest: "none",
				},
			}),
		...softDelete,
		...timestamps,
	},
	(table) => [
		uniqueIndex("uq_users_email").on(table.email),
	],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

/** @info - Relations */
export const usersRelations = relations(users, ({ many }) => ({
	roles: many(user_roles),
}));
