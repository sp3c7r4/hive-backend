/**
 * @info - AI grading assist tables.
 *
 * gradingBatches: one row per mass-grading run; the source of truth for
 * batch progress (the SSE stream only tails it, never replaces it).
 * aiGradingLogs: one row per AI grading run (single or batch), mirroring
 * the ai_tutor_logs append-only pattern.
 */
import { index, integer, pgEnum, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { TableNames } from "@/enums";
import { users } from "@/modules/user/user.model";
import { lessons } from "@/modules/courses/course.model";
import { assignmentSubmissions } from "@/modules/assessments/assessment.model";

export const gradingBatchStatusEnum = pgEnum("grading_batch_status", [
	"running",
	"completed",
	"completed_with_errors",
]);

export const gradingBatches = pgTable(
	TableNames.GRADING_BATCHES,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		lessonId: integer("lesson_id")
			.notNull()
			.references(() => lessons.id, { onDelete: "cascade" }),
		createdBy: integer("created_by")
			.notNull()
			.references(() => users.id),
		totalCount: integer("total_count").notNull(),
		completedCount: integer("completed_count").default(0).notNull(),
		failedCount: integer("failed_count").default(0).notNull(),
		status: gradingBatchStatusEnum("status").default("running").notNull(),
		instructorContext: text("instructor_context"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		completedAt: timestamp("completed_at"),
	},
	(table) => [
		index("idx_grading_batches_lesson").on(table.lessonId, table.createdAt),
	],
);

export const aiGradingLogs = pgTable(
	TableNames.AI_GRADING_LOGS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		batchId: integer("batch_id").references(() => gradingBatches.id, {
			onDelete: "set null",
		}),
		submissionId: integer("submission_id")
			.notNull()
			.references(() => assignmentSubmissions.id, { onDelete: "cascade" }),
		suggestedScore: integer("suggested_score"),
		suggestedFeedback: text("suggested_feedback"),
		instructorContext: text("instructor_context"),
		model: varchar("model", { length: 100 }),
		status: varchar("status", { length: 20 }).default("completed").notNull(),
		approvedEdited: varchar("approved_edited", { length: 20 }),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("idx_ai_grading_logs_submission").on(table.submissionId, table.createdAt),
		index("idx_ai_grading_logs_batch").on(table.batchId),
	],
);

export type GradingBatch = typeof gradingBatches.$inferSelect;
export type NewGradingBatch = typeof gradingBatches.$inferInsert;
export type AiGradingLog = typeof aiGradingLogs.$inferSelect;
export type NewAiGradingLog = typeof aiGradingLogs.$inferInsert;
