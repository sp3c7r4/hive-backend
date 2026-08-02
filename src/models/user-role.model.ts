import {
	integer,
	pgTable,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { RelationalRepository } from "@/bases/repositories";
import { userRoleEnum } from "@/bases/models/base.user.model";
import { TableNames } from "@/enums";
import { users } from "./user.model";

/**
 * @info - Junction table linking users to their roles. One user can have
 *         multiple roles (e.g. instructor + student). The enum is defined in
 *         base.user.model.ts for drizzle-kit discovery.
 */
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
	],
);

export type UserRoleRow = typeof user_roles.$inferSelect;
export type NewUserRoleRow = typeof user_roles.$inferInsert;

/** @info - Relations */
export const userRolesRelations = relations(user_roles, ({ one }) => ({
	user: one(users, {
		fields: [user_roles.userId],
		references: [users.id],
	}),
}));

export class UserRoleRepository extends RelationalRepository<typeof user_roles> {
	private static instance: UserRoleRepository;

	static getInstance(): UserRoleRepository {
		if (!this.instance) this.instance = new UserRoleRepository();
		return this.instance;
	}

	private constructor() {
		super(user_roles);
	}
}
