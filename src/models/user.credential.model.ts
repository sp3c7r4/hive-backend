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
import { AuthMethods, ModelCollections } from "@/enums";
import type { IUserCredentialTokens } from "@/interfaces";
import { user } from "@/modules/user/user.model";
import { timestamps } from "./timestamps.b.model";

const collectionName = ModelCollections.USER_CREDENTIAL;

export const providerEnum = pgEnum(
	"auth_provider",
	Object.values(_.omit(AuthMethods, AuthMethods.EMAIL)) as [
		string,
		...string[],
	],
);

export const userCredential = pgTable(
	collectionName,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		userId: integer("user_id")
			.references(() => user.id, { onDelete: "cascade" })
			.notNull(),
		provider: providerEnum("provider").notNull(),
		providerAccountId: varchar("provider_account_id", {
			length: 255,
		}).notNull(),
		tokens: jsonb("tokens").default({}).$type<IUserCredentialTokens>(),
		...timestamps,
	},
	(t) => [
		uniqueIndex("unique_provider_account_id").on(
			t.provider,
			t.providerAccountId,
		),
		index("user_credential_user_id_idx").on(t.userId),
	],
);

export type UserCredential = typeof userCredential.$inferSelect;
