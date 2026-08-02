import {
	boolean,
	index,
	integer,
	pgTable,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { TableNames } from "@/enums";
import { users } from "@/models/user.model";
import { courses, lessons } from "@/modules/courses/course.model";
import { payments } from "@/modules/payment/payment.model";
import { certificates } from "@/modules/certificates/certificate.model";
import { softDelete } from "@/models/soft-delete.model";
import { timestamps } from "@/models/timestamps.b.model";

/** @info - Tracks a user's enrollment in a course */
export const enrollments = pgTable(
	TableNames.ENROLLMENTS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		courseId: integer("course_id")
			.notNull()
			.references(() => courses.id, { onDelete: "cascade" }),
		/** @info - Parent who paid for this enrollment, null if self-enrolled */
		enrolledById: integer("enrolled_by_id")
			.references(() => users.id, { onDelete: "set null" }),
		progressPercent: integer("progress_percent").default(0),
		completedAt: timestamp("completed_at"),
		expiresAt: timestamp("expires_at"),
		...timestamps,
		...softDelete,
	},
	(table) => [
		uniqueIndex("uq_enrollment").on(table.userId, table.courseId),
		index("idx_enrollments_user").on(table.userId),
		index("idx_enrollments_course").on(table.courseId),
		index("idx_enrollments_enrolled_by").on(table.enrolledById),
	],
);

/** @info - Per-lesson completion tracking within an enrollment */
export const lessonProgress = pgTable(
	TableNames.LESSON_PROGRESS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		enrollmentId: integer("enrollment_id")
			.notNull()
			.references(() => enrollments.id, { onDelete: "cascade" }),
		lessonId: integer("lesson_id")
			.notNull()
			.references(() => lessons.id, { onDelete: "cascade" }),
		completed: boolean("completed").default(false),
		lastPositionSeconds: integer("last_position_seconds").default(0),
		completedAt: timestamp("completed_at"),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("uq_lesson_progress").on(table.enrollmentId, table.lessonId),
		index("idx_lesson_progress_enrollment").on(table.enrollmentId),
		index("idx_lesson_progress_lesson").on(table.lessonId),
	],
);

export type Enrollment = typeof enrollments.$inferSelect;
export type NewEnrollment = typeof enrollments.$inferInsert;
export type LessonProgress = typeof lessonProgress.$inferSelect;
export type NewLessonProgress = typeof lessonProgress.$inferInsert;

/** @info - Relations */
export const enrollmentsRelations = relations(enrollments, ({ one, many }) => ({
	user: one(users, {
		fields: [enrollments.userId],
		references: [users.id],
	}),
	course: one(courses, {
		fields: [enrollments.courseId],
		references: [courses.id],
	}),
	enrolledBy: one(users, {
		fields: [enrollments.enrolledById],
		references: [users.id],
	}),
	lessonProgress: many(lessonProgress),
	payments: many(payments),
	certificates: many(certificates),
}));

export const lessonProgressRelations = relations(lessonProgress, ({ one }) => ({
	enrollment: one(enrollments, {
		fields: [lessonProgress.enrollmentId],
		references: [enrollments.id],
	}),
	lesson: one(lessons, {
		fields: [lessonProgress.lessonId],
		references: [lessons.id],
	}),
}));
