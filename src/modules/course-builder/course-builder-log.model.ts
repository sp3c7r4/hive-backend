/**
 * @info - AI course builder audit log. Append-only, one row per completed
 * or blocked generation (draft or single-module regenerate).
 */
import { index, integer, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { TableNames } from "@/enums";
import { users } from "@/modules/user/user.model";

export const aiCourseBuilderLogs = pgTable(
	TableNames.AI_COURSE_BUILDER_LOGS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		mode: varchar("mode", { length: 20 }).notNull(),
		syllabus: text("syllabus"),
		resultSummary: text("result_summary"),
		status: varchar("status", { length: 20 }).default("completed").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("idx_ai_course_builder_logs_user").on(table.userId, table.createdAt),
	],
);

export type AiCourseBuilderLog = typeof aiCourseBuilderLogs.$inferSelect;
export type NewAiCourseBuilderLog = typeof aiCourseBuilderLogs.$inferInsert;
