import {
	integer,
	jsonb,
	pgTable,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { TableNames } from "@/enums";
import { timestamps } from "@/models/timestamps.b.model";
import { users } from "@/models/user.model";
import { quizAttempts, assignmentSubmissions } from "@/modules/assessments/assessment.model";
import { certificates } from "@/modules/certificates/certificate.model";
import { enrollments } from "@/modules/enrollments/enrollment.model";
import { parentChildLinks } from "@/modules/parent/parent.model";
import { payments } from "@/modules/payment/payment.model";
import { reviews } from "@/modules/reviews/review.model";

/** @info - Student-specific profile. Core identity lives in users table. */
export const studentProfiles = pgTable(
	TableNames.STUDENT_PROFILES,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		interestTags: jsonb("interest_tags").$type<string[]>().default([]),
		...timestamps,
	},
);

export type StudentProfile = typeof studentProfiles.$inferSelect;
export type NewStudentProfile = typeof studentProfiles.$inferInsert;

/** @info - Relations */
export const studentProfilesRelations = relations(studentProfiles, ({ one, many }) => ({
	user: one(users, {
		fields: [studentProfiles.userId],
		references: [users.id],
	}),
	quizAttempts: many(quizAttempts),
	assignmentSubmissions: many(assignmentSubmissions),
	certificates: many(certificates),
	enrollments: many(enrollments),
	parentChildLinks: many(parentChildLinks),
	payments: many(payments),
	reviews: many(reviews),
}));
