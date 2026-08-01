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
import { students } from "@/modules/student/student.model";
import { courses } from "@/modules/courses/course.model";
import { instructors } from "@/modules/instructor/instructor.model";
import { timestamps } from "@/models/timestamps.b.model";

/** @info - Student review for a course, one per student per course */
export const reviews = pgTable(
	TableNames.REVIEWS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		courseId: integer("course_id")
			.notNull()
			.references(() => courses.id, { onDelete: "cascade" }),
		/** @info - The student who wrote this review */
		userId: integer("user_id")
			.notNull()
			.references(() => students.id, { onDelete: "cascade" }),
		/** @info - 1–5 star rating */
		rating: integer("rating").notNull(),
		title: varchar("title", { length: 255 }),
		comment: text("comment").notNull(),
		helpfulCount: integer("helpful_count").default(0),
		/** @info - IDs of users who marked this review as helpful */
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

/** @info - Instructor's reply to a student review, one reply per review */
export const instructorReplies = pgTable(
	TableNames.INSTRUCTOR_REPLIES,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		reviewId: integer("review_id")
			.notNull()
			.references(() => reviews.id, { onDelete: "cascade" }),
		instructorId: integer("instructor_id")
			.notNull()
			.references(() => instructors.id, { onDelete: "cascade" }),
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
	student: one(students, {
		fields: [reviews.userId],
		references: [students.id],
	}),
	reply: one(instructorReplies),
}));

export const instructorRepliesRelations = relations(instructorReplies, ({ one }) => ({
	review: one(reviews, {
		fields: [instructorReplies.reviewId],
		references: [reviews.id],
	}),
	instructor: one(instructors, {
		fields: [instructorReplies.instructorId],
		references: [instructors.id],
	}),
}));
