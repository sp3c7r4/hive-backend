import {
	integer,
	pgTable,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { relations } from "drizzle-orm";
import { userRoleEnum } from "@/bases/models/base.user.model";
import { TableNames } from "@/enums";
import { users } from "./user.model";

export const user_roles = pgTable(
	TableNames.USER_ROLES,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		role: userRoleEnum("role").notNull(),
	},
	(table) => [
		uniqueIndex("uq_user_role").on(table.userId, table.role),
		/* @info - One WORKING role per user (admin exempt): multi-role grants the
		 *         union of permissions and breaks role-scoped tests. Migration
		 *         0027 merges existing extras before creating this. */
		uniqueIndex("uq_user_role_single_working")
			.on(table.userId)
			.where(sql`${table.role} <> 'admin'`),
	],
);

export type UserRoleRow = typeof user_roles.$inferSelect;
export type NewUserRoleRow = typeof user_roles.$inferInsert;

export const userRolesRelations = relations(user_roles, ({ one }) => ({
	user: one(users, {
		fields: [user_roles.userId],
		references: [users.id],
	}),
}));
