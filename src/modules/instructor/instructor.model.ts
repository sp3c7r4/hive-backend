import {
	boolean,
	jsonb,
	pgTable,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { BaseUser } from "@/bases/models/base.user.model";
import { TableNames } from "@/enums";
import { softDelete } from "@/models/soft-delete.model";
import { communities } from "@/modules/communities/community.model";
import { courses } from "@/modules/courses/course.model";
import { instructorReplies } from "@/modules/reviews/review.model";
import { withdrawals } from "@/modules/payment/payment.model";

/** @info - Instructor — spreads BaseUser. There is no separate users table. */
export const instructors = pgTable(
	TableNames.INSTRUCTORS,
	{
		...BaseUser,
		/** @info - Teaching specialization tags e.g. ["Web Development", "Graphic Design"] */
		specializationTags: jsonb("specialization_tags").$type<string[]>().default([]),
		/** @info - Admin flag for platform management */
		isAdmin: boolean("is_admin").default(false),
		...softDelete,
	},
	(table) => [
		uniqueIndex("uq_instructors_email").on(table.email),
	],
);

export type Instructor = typeof instructors.$inferSelect;
export type NewInstructor = typeof instructors.$inferInsert;

/** @info - Relations */
export const instructorsRelations = relations(instructors, ({ many }) => ({
	communities: many(communities),
	courses: many(courses),
	replies: many(instructorReplies),
	withdrawals: many(withdrawals),
}));
