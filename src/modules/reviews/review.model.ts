import {
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { TableNames } from "@/enums";
import { users } from "@/models/user.model";
import { courses } from "@/modules/courses/course.model";
import { timestamps } from "@/models/timestamps.b.model";

/** @info - User review for a course, one per user per course */
export const reviews = pgTable(
	TableNames.REVIEWS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		courseId: integer("course_id")
			.notNull()
			.references(() => courses.id, { onDelete: "cascade" }),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		rating: integer("rating").notNull(),
		title: varchar("title", { length: 255 }),
		comment: text("comment").notNull(),
		helpfulCount: integer("helpful_count").default(0),
		helpfulByUserIds: jsonb("helpful_by_user_ids").$type<number[]>().default([]),
		...timestamps,
	},
	(table) => [
		uniqueIndex("uq_review").on(table.courseId, table.userId),
		index("idx_reviews_course").on(table.courseId),
		index("idx_reviews_user").on(table.userId),
		index("idx_reviews_rating").on(table.rating),
	],
);

/** @info - Instructor's reply to a user review, one reply per review */
export const instructorReplies = pgTable(
	TableNames.INSTRUCTOR_REPLIES,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		reviewId: integer("review_id")
			.notNull()
			.references(() => reviews.id, { onDelete: "cascade" }),
		instructorId: integer("instructor_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		comment: text("comment").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("uq_instructor_reply").on(table.reviewId),
		index("idx_instructor_replies_instructor").on(table.instructorId),
	],
);

export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
export type InstructorReply = typeof instructorReplies.$inferSelect;
export type NewInstructorReply = typeof instructorReplies.$inferInsert;

/** @info - Relations */
export const reviewsRelations = relations(reviews, ({ one }) => ({
	course: one(courses, {
		fields: [reviews.courseId],
		references: [courses.id],
	}),
	user: one(users, {
		fields: [reviews.userId],
		references: [users.id],
	}),
	reply: one(instructorReplies),
}));

export const instructorRepliesRelations = relations(instructorReplies, ({ one }) => ({
	review: one(reviews, {
		fields: [instructorReplies.reviewId],
		references: [reviews.id],
	}),
	instructor: one(users, {
		fields: [instructorReplies.instructorId],
		references: [users.id],
	}),
}));
