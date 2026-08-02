import {
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import _ from "lodash";
import { AuthMethods, TableNames } from "@/enums";
import { userRoleEnum } from "@/bases/models/base.user.model";
import { users } from "./user.model";
import { timestamps } from "./timestamps.b.model";

export const providerEnum = pgEnum(
	"auth_provider",
	Object.values(_.omit(AuthMethods, AuthMethods.EMAIL)) as [
		string,
		...string[],
	],
);

/** @info - OAuth credential linking a user to a provider account */
export const userCredentials = pgTable(
	TableNames.USER_CREDENTIALS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		role: userRoleEnum("role").notNull(),
		provider: providerEnum("provider").notNull(),
		providerAccountId: varchar("provider_account_id", {
			length: 255,
		}).notNull(),
		tokens: jsonb("tokens").default({}).$type<{
			accessToken: string;
			refreshToken?: string;
			idToken?: string;
			expiryDate?: string;
			scope?: string;
			tokenType?: string;
		}>(),
		...timestamps,
	},
	(t) => [
		uniqueIndex("uq_user_credential_provider").on(
			t.provider,
			t.providerAccountId,
		),
		index("idx_user_credentials_user").on(t.userId),
	],
);

export type UserCredential = typeof userCredentials.$inferSelect;
export type NewUserCredential = typeof userCredentials.$inferInsert;

/** @info - Relations */
export const userCredentialsRelations = relations(userCredentials, ({ one }) => ({
	user: one(users, {
		fields: [userCredentials.userId],
		references: [users.id],
	}),
}));
