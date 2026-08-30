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
import { users } from "@/modules/user/user.model";
import { courses } from "@/modules/courses/course.model";
import { enrollments } from "@/modules/enrollments/enrollment.model";

/** @info - Issued when a user meets all certificate requirements for a course */
export const certificates = pgTable(
	TableNames.CERTIFICATES,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		courseId: integer("course_id")
			.notNull()
			.references(() => courses.id, { onDelete: "cascade" }),
		enrollmentId: integer("enrollment_id")
			.notNull()
			.references(() => enrollments.id, { onDelete: "cascade" }),
		code: varchar("code", { length: 100 }).notNull(),
		fileUrl: varchar("file_url", { length: 500 }),
		issuedAt: timestamp("issued_at").defaultNow().notNull(),
		completionPercent: integer("completion_percent").notNull(),
		quizScorePercent: integer("quiz_score_percent").notNull(),
		attendancePercent: integer("attendance_percent").notNull(),
	},
	(table) => [
		uniqueIndex("uq_certificates_code").on(table.code),
		uniqueIndex("uq_certificate_user_course").on(table.userId, table.courseId),
		index("idx_certificates_user").on(table.userId),
		index("idx_certificates_course").on(table.courseId),
		index("idx_certificates_enrollment").on(table.enrollmentId),
	],
);

export type Certificate = typeof certificates.$inferSelect;
export type NewCertificate = typeof certificates.$inferInsert;

/** @info - Relations */
export const certificatesRelations = relations(certificates, ({ one }) => ({
	user: one(users, {
		fields: [certificates.userId],
		references: [users.id],
	}),
	course: one(courses, {
		fields: [certificates.courseId],
		references: [courses.id],
	}),
	enrollment: one(enrollments, {
		fields: [certificates.enrollmentId],
		references: [enrollments.id],
	}),
}));
