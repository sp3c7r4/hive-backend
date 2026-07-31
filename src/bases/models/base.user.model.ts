import {
	boolean,
	integer,
	jsonb,
	text,
	timestamp,
	varchar,
} from "drizzle-orm/pg-core";
import type { IUserPreferences } from "@/interfaces";
import { timestamps } from "@/models/timestamps.b.model";

export const BaseUser = {
	id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
	firstName: varchar("first_name", { length: 255 }).notNull(),
	lastName: varchar("last_name", { length: 255 }),
	email: varchar("email", { length: 255 }).notNull(),
	emailVerified: boolean("email_verified").default(false),
	emailVerifiedAt: timestamp("email_verified_at"),
	lastLoginAt: timestamp("last_login_at"),
	avatar: varchar("avatar", { length: 255 }),
	bio: text("bio"),
	phone: varchar("phone", { length: 50 }),
	phoneVerified: boolean("phone_verified").default(false),
	isAdmin: boolean("is_admin").default(false),
	passwordChangedAt: timestamp("password_changed_at"),
	onboarded: boolean("onboarded").default(false),
	hash: varchar("hash", { length: 255 }),
	preferences: jsonb("preferences")
		.$type<IUserPreferences>()
		.default({
			theme: "system" /** @info - light, dark, system */,
			locale: "en-US",
			timezone: "UTC",
			notifications: {
				email: true,
				push: true,
				marketing: false,
				digest: "none" /** @info - daily, weekly, none */,
			},
		}),
	...timestamps,
};
