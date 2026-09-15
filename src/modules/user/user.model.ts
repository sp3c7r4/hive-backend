import {
	boolean,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	varchar,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import type { IUserPreferences } from "@/interfaces";
import { TableNames } from "@/enums";
import { softDelete } from "@/models/soft-delete.model";
import { timestamps } from "@/models/timestamps.b.model";
import { user_roles } from "./user-role.model";

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
					sms: false,
					whatsapp: false,
					push: true,
				},
			}),
		suspendedAt: timestamp("suspended_at"),
		/** @info - Last verified payout destination (one per instructor). Written
		 *         only by the withdrawal service, which re-resolves the account
		 *         name with Paystack first — never from client input. */
		payoutBankName: varchar("payout_bank_name", { length: 255 }),
		payoutBankCode: varchar("payout_bank_code", { length: 20 }),
		payoutAccountNumber: varchar("payout_account_number", { length: 20 }),
		payoutAccountName: varchar("payout_account_name", { length: 255 }),
		payoutAccountVerifiedAt: timestamp("payout_account_verified_at"),
		...softDelete,
		...timestamps,
	},
);

/* @info - Email uniqueness is CASE-INSENSITIVE: enforced by
 * uq_users_email_lower ON users (lower(email)), created in migration
 * 0020_email_case_insensitive.sql (replaces the old case-sensitive
 * uq_users_email). Code paths must store/lookup lowercase emails. */

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export const usersRelations = relations(users, ({ many }) => ({
	roles: many(user_roles),
}));
