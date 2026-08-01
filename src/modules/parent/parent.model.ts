import {
	index,
	integer,
	pgTable,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { BaseUser } from "@/bases/models/base.user.model";
import { TableNames } from "@/enums";
import { students } from "@/modules/student/student.model";
import { enrollments } from "@/modules/enrollments/enrollment.model";
import { softDelete } from "@/models/soft-delete.model";

/** @info - Parent — spreads BaseUser. There is no separate users table. */
export const parents = pgTable(
	TableNames.PARENTS,
	{
		...BaseUser,
		...softDelete,
	},
	(table) => [
		uniqueIndex("uq_parents_email").on(table.email),
	],
);

/** @info - Links a parent to a child student for monitoring */
export const parentChildLinks = pgTable(
	TableNames.PARENT_CHILD_LINKS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		parentId: integer("parent_id")
			.notNull()
			.references(() => parents.id, { onDelete: "cascade" }),
		studentId: integer("student_id")
			.notNull()
			.references(() => students.id, { onDelete: "cascade" }),
		linkedAt: timestamp("linked_at").defaultNow().notNull(),
		...softDelete,
	},
	(table) => [
		uniqueIndex("uq_parent_child_link").on(table.parentId, table.studentId),
		index("idx_parent_child_parent").on(table.parentId),
		index("idx_parent_child_student").on(table.studentId),
	],
);

export type Parent = typeof parents.$inferSelect;
export type NewParent = typeof parents.$inferInsert;
export type ParentChildLink = typeof parentChildLinks.$inferSelect;
export type NewParentChildLink = typeof parentChildLinks.$inferInsert;

/** @info - Relations */
export const parentsRelations = relations(parents, ({ many }) => ({
	childLinks: many(parentChildLinks),
	enrollments: many(enrollments),
}));

export const parentChildLinksRelations = relations(parentChildLinks, ({ one }) => ({
	parent: one(parents, {
		fields: [parentChildLinks.parentId],
		references: [parents.id],
	}),
	student: one(students, {
		fields: [parentChildLinks.studentId],
		references: [students.id],
	}),
}));
