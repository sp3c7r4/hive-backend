import {
	index,
	integer,
	pgTable,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { TableNames } from "@/enums";
import { timestamps } from "@/models/timestamps.b.model";
import { users } from "@/modules/user/user.model";

/** @info - Parent-specific profile. Core identity lives in users table. */
export const parentProfiles = pgTable(
	TableNames.PARENT_PROFILES,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		...timestamps,
	},
);

/** @info - Links a parent to a child student for monitoring. Supports pending invites. */
export const parentChildLinks = pgTable(
	TableNames.PARENT_CHILD_LINKS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		parentId: integer("parent_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		/** @info - Null until the child accepts the invite or signs up */
		studentId: integer("student_id")
			.references(() => users.id, { onDelete: "cascade" }),
		/** @info - Email used to look up the child (stored while pending) */
		linkedEmail: varchar("linked_email", { length: 255 }),
		status: varchar("status", { length: 20 }).default("active").notNull(),
		linkedAt: timestamp("linked_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("uq_parent_child_link").on(table.parentId, table.studentId),
		index("idx_parent_child_parent").on(table.parentId),
		index("idx_parent_child_student").on(table.studentId),
		index("idx_parent_child_email").on(table.linkedEmail),
	],
);

export type ParentProfile = typeof parentProfiles.$inferSelect;
export type NewParentProfile = typeof parentProfiles.$inferInsert;
export type ParentChildLink = typeof parentChildLinks.$inferSelect;
export type NewParentChildLink = typeof parentChildLinks.$inferInsert;

/** @info - Relations */
export const parentProfilesRelations = relations(parentProfiles, ({ one, many }) => ({
	user: one(users, {
		fields: [parentProfiles.userId],
		references: [users.id],
	}),
	childLinks: many(parentChildLinks),
}));

export const parentChildLinksRelations = relations(parentChildLinks, ({ one }) => ({
	parent: one(users, {
		fields: [parentChildLinks.parentId],
		references: [users.id],
	}),
	student: one(users, {
		fields: [parentChildLinks.studentId],
		references: [users.id],
	}),
}));
