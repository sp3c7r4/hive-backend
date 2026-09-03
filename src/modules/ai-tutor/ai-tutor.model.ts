/**
 * @info - AI course tutor tables.
 *
 * lessonChunks: one row per embedded text chunk of a published lesson,
 * scoped by course_id. lessonType is stored for audits (grounding audits).
 * aiTutorLogs: append-only log of every tutor exchange.
 */
import {
	boolean,
	customType,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	varchar,
} from "drizzle-orm/pg-core";
import { TableNames } from "@/enums";
import { courses, lessons } from "@/modules/courses/course.model";
import { users } from "@/modules/user/user.model";

/** @info - pgvector column; 384-dim vectors from fast-bge-small-en-v1.5 */
const vector384 = customType<{ data: string; driverData: string }>({
	dataType: () => "vector(384)",
});

export const lessonChunks = pgTable(
	TableNames.LESSON_CHUNKS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		courseId: integer("course_id")
			.notNull()
			.references(() => courses.id, { onDelete: "cascade" }),
		lessonId: integer("lesson_id")
			.notNull()
			.references(() => lessons.id, { onDelete: "cascade" }),
		lessonType: varchar("lesson_type", { length: 50 }).notNull(),
		content: text("content").notNull(),
		embedding: vector384("embedding").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		index("idx_lesson_chunks_course").on(table.courseId),
		index("idx_lesson_chunks_lesson").on(table.lessonId),
	],
);

export const aiTutorLogs = pgTable(TableNames.AI_TUTOR_LOGS, {
	id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
	userId: integer("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	courseId: integer("course_id")
		.notNull()
		.references(() => courses.id, { onDelete: "cascade" }),
	question: text("question").notNull(),
	chunkIds: jsonb("chunk_ids").$type<number[]>().default([]).notNull(),
	answer: text("answer"),
	guardrail: varchar("guardrail", { length: 100 }),
	usedFallback: boolean("used_fallback").default(false).notNull(),
	createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type LessonChunk = typeof lessonChunks.$inferSelect;
export type AiTutorLog = typeof aiTutorLogs.$inferSelect;
