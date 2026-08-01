import {
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";
import _ from "lodash";
import { AuthMethods, UserRole, TableNames } from "@/enums";
import { timestamps } from "./timestamps.b.model";

const providerEnum = pgEnum(
	"auth_provider",
	Object.values(_.omit(AuthMethods, AuthMethods.EMAIL)) as [
		string,
		...string[],
	],
);

const userRoleEnum = pgEnum(
	"user_role",
	Object.values(UserRole) as [string, ...string[]],
);

/** @info - OAuth credential linking a polymorphic user (instructor/student/parent) to a provider account */
export const userCredentials = pgTable(
	TableNames.USER_CREDENTIALS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		entityId: integer("entity_id").notNull(),
		entityType: userRoleEnum("entity_type").notNull(),
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
		index("idx_user_credentials_entity").on(t.entityId, t.entityType),
	],
);

export type UserCredential = typeof userCredentials.$inferSelect;
export type NewUserCredential = typeof userCredentials.$inferInsert;
