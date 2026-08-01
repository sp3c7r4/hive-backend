import {
	jsonb,
	pgTable,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { BaseUser } from "@/bases/models/base.user.model";
import { TableNames } from "@/enums";
import { softDelete } from "@/models/soft-delete.model";
import { quizAttempts, assignmentSubmissions } from "@/modules/assessments/assessment.model";
import { certificates } from "@/modules/certificates/certificate.model";
import { enrollments } from "@/modules/enrollments/enrollment.model";
import { parentChildLinks } from "@/modules/parent/parent.model";
import { payments } from "@/modules/payment/payment.model";
import { reviews } from "@/modules/reviews/review.model";

/** @info - Student — spreads BaseUser. There is no separate users table. */
export const students = pgTable(
	TableNames.STUDENTS,
	{
		...BaseUser,
		/** @info - Interest tags e.g. ["Mathematics", "Physics"] for personalized recommendations */
		interestTags: jsonb("interest_tags").$type<string[]>().default([]),
		...softDelete,
	},
	(table) => [
		uniqueIndex("uq_students_email").on(table.email),
	],
);

export type Student = typeof students.$inferSelect;
export type NewStudent = typeof students.$inferInsert;

/** @info - Relations */
export const studentsRelations = relations(students, ({ many }) => ({
	quizAttempts: many(quizAttempts),
	assignmentSubmissions: many(assignmentSubmissions),
	certificates: many(certificates),
	enrollments: many(enrollments),
	parentChildLinks: many(parentChildLinks),
	payments: many(payments),
	reviews: many(reviews),
}));
