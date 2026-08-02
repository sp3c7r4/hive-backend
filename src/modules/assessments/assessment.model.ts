import {
	boolean,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { lessons } from "@/modules/courses/course.model";
import { users } from "@/modules/user/user.model";
import {
	QuizQuestionType,
	AssignmentSubmissionStatus,
	TableNames,
} from "@/enums";
import { timestamps } from "@/models/timestamps.b.model";

export const quizQuestionTypeEnum = pgEnum("quiz_question_type", Object.values(QuizQuestionType) as [string, ...string[]]);
export const assignmentSubmissionStatusEnum = pgEnum(
	"assignment_submission_status",
	Object.values(AssignmentSubmissionStatus) as [string, ...string[]],
);

/** @info - Individual question within a quiz-type lesson */
export const quizQuestions = pgTable(
	TableNames.QUIZ_QUESTIONS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		lessonId: integer("lesson_id")
			.notNull()
			.references(() => lessons.id, { onDelete: "cascade" }),
		type: quizQuestionTypeEnum("type").default("multiple").notNull(),
		text: text("text").notNull(),
		/** @info - null for fillblank type questions */
		options: jsonb("options").$type<string[]>(),
		correctAnswer: varchar("correct_answer", { length: 500 }).notNull(),
		explanation: text("explanation"),
		points: integer("points").default(1).notNull(),
		sortOrder: integer("sort_order").default(0).notNull(),
		...timestamps,
	},
	(table) => [
		index("idx_quiz_questions_lesson").on(table.lessonId),
	],
);

/** @info - One record per question per user per attempt */
export const quizAttempts = pgTable(
	TableNames.QUIZ_ATTEMPTS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		lessonId: integer("lesson_id")
			.notNull()
			.references(() => lessons.id, { onDelete: "cascade" }),
		questionId: integer("question_id")
			.notNull()
			.references(() => quizQuestions.id, { onDelete: "cascade" }),
		selectedAnswer: varchar("selected_answer", { length: 500 }),
		isCorrect: boolean("is_correct").default(false),
		attemptedAt: timestamp("attempted_at").defaultNow().notNull(),
	},
	(table) => [
		index("idx_quiz_attempts_user").on(table.userId),
		index("idx_quiz_attempts_lesson").on(table.lessonId),
		index("idx_quiz_attempts_question").on(table.questionId),
	],
);

/** @info - User submission for an assignment-type lesson */
export const assignmentSubmissions = pgTable(
	TableNames.ASSIGNMENT_SUBMISSIONS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		lessonId: integer("lesson_id")
			.notNull()
			.references(() => lessons.id, { onDelete: "cascade" }),
		text: text("text"),
		fileUrls: jsonb("file_urls").$type<string[]>().default([]),
		status: assignmentSubmissionStatusEnum("status").default("pending").notNull(),
		score: integer("score"),
		feedback: text("feedback"),
		submittedAt: timestamp("submitted_at"),
		gradedAt: timestamp("graded_at"),
		...timestamps,
	},
	(table) => [
		uniqueIndex("uq_assignment_submission").on(table.userId, table.lessonId),
		index("idx_assignment_submissions_user").on(table.userId),
		index("idx_assignment_submissions_lesson").on(table.lessonId),
		index("idx_assignment_submissions_status").on(table.status),
	],
);

export type QuizQuestion = typeof quizQuestions.$inferSelect;
export type NewQuizQuestion = typeof quizQuestions.$inferInsert;
export type QuizAttempt = typeof quizAttempts.$inferSelect;
export type NewQuizAttempt = typeof quizAttempts.$inferInsert;
export type AssignmentSubmission = typeof assignmentSubmissions.$inferSelect;
export type NewAssignmentSubmission = typeof assignmentSubmissions.$inferInsert;

/** @info - Relations */
export const quizQuestionsRelations = relations(quizQuestions, ({ one, many }) => ({
	lesson: one(lessons, {
		fields: [quizQuestions.lessonId],
		references: [lessons.id],
	}),
	attempts: many(quizAttempts),
}));

export const quizAttemptsRelations = relations(quizAttempts, ({ one }) => ({
	user: one(users, {
		fields: [quizAttempts.userId],
		references: [users.id],
	}),
	lesson: one(lessons, {
		fields: [quizAttempts.lessonId],
		references: [lessons.id],
	}),
	question: one(quizQuestions, {
		fields: [quizAttempts.questionId],
		references: [quizQuestions.id],
	}),
}));

export const assignmentSubmissionsRelations = relations(assignmentSubmissions, ({ one }) => ({
	user: one(users, {
		fields: [assignmentSubmissions.userId],
		references: [users.id],
	}),
	lesson: one(lessons, {
		fields: [assignmentSubmissions.lessonId],
		references: [lessons.id],
	}),
}));
