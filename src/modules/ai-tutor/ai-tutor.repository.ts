/**
 * @info - Vector search + audit log for the course tutor.
 * Raw SQL on purpose: pgvector operators have no Drizzle builder.
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";

export interface ChunkHit {
	id: number;
	content: string;
	lessonType: string;
	similarity: number;
}

export interface TutorLogInput {
	userId: number;
	courseId: number;
	question: string;
	chunkIds: number[];
	answer: string | null;
	guardrail?: string;
	usedFallback?: boolean;
}

export class AiTutorRepository {
	/**
	 * @info - Cosine search scoped by courseId AND the reached-lesson gate.
	 * These two filters are the isolation guarantee: nothing outside this
	 * course, nothing the student has not reached.
	 */
	searchChunks = async (
		courseId: number,
		reachedLessonIds: number[],
		vectorLiteral: string,
		limit = 6,
	): Promise<ChunkHit[]> => {
		const db = getDb();
		if (reachedLessonIds.length === 0) return [];
		const rows = await db.execute(sql`
			SELECT id, content, lesson_type AS "lessonType",
			       1 - (embedding <=> ${vectorLiteral}::vector) AS similarity
			FROM lesson_chunks
			WHERE course_id = ${courseId}
			  AND lesson_id IN (${sql.join(reachedLessonIds.map((id) => sql`${id}`), sql`, `)})
			ORDER BY embedding <=> ${vectorLiteral}::vector
			LIMIT ${limit}
		`);
		return ((rows as unknown as { rows: ChunkHit[] }).rows ?? []).filter(
			(r) => r && r.id !== undefined,
		);
	};

	/** @info - Append-only audit row for every tutor exchange */
	createLog = async (input: TutorLogInput) => {
		const db = getDb();
		await db.execute(sql`
			INSERT INTO ai_tutor_logs
				(user_id, course_id, question, chunk_ids, answer, guardrail, used_fallback)
			VALUES (${input.userId}, ${input.courseId}, ${input.question},
				${JSON.stringify(input.chunkIds)}, ${input.answer}, ${input.guardrail ?? null},
				${input.usedFallback ?? false})
		`);
	};
}
