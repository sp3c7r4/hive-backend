/**
 * @info - LessonChunkWorkerService: EMBED_LESSON jobs.
 * Extracts groundable text from a published lesson, chunks it, embeds each
 * chunk with fastembed, and replaces the lesson's rows in lesson_chunks.
 * Delete + re-insert makes repeated jobs naturally idempotent.
 */
import type { Job } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import { logger } from "@/utils";
import { BaseWorkerService } from "@/bases/services/base.worker.service";
import { JobNames, QueueNames } from "@/enums";
import { RelationalRepository } from "@/bases/repositories/relational.repository";
import { lessons } from "@/modules/courses/course.model";
import { quizQuestions } from "@/modules/assessments/assessment.model";
import { EmbeddingService } from "@/services/ai/embedding.service";
import {
	chunkText,
	extractLessonText,
} from "@/helpers/ai/lesson-content.helper";
import type { LessonChunkJobData } from "@/services/queues/lesson-chunk.queue.service";

export class LessonChunkWorkerService extends BaseWorkerService<LessonChunkJobData> {
	private static instance: LessonChunkWorkerService;
	private readonly log = logger;

	static getInstance(): LessonChunkWorkerService {
		if (!this.instance) this.instance = new LessonChunkWorkerService();
		return this.instance;
	}

	private constructor() {
		super({
			queueName: QueueNames.LESSON_CHUNK,
			alias: "LessonChunkWorker",
			concurrency: 2,
		});
	}

	protected async process(job: Job<LessonChunkJobData>): Promise<void> {
		const { lessonId, courseId } = job.data;
		const db = getDb();

		const lesson = await new RelationalRepository(lessons, db).findById(
			lessonId,
		);
		if (!lesson) {
			this.log.warn(`[LessonChunk] Lesson ${lessonId} not found, skipping`);
			return;
		}
		if (lesson.status !== "published") {
			this.log.info(`[LessonChunk] Lesson ${lessonId} not published, skipping`);
			return;
		}

		/* @info - Extract text (PDFs and Drive exports are fetched here) */
		const questions = await new RelationalRepository(
			quizQuestions,
			db,
		).findMany(eq(quizQuestions.lessonId, lessonId));
		const text = await extractLessonText(lesson, questions);
		if (!text) {
			this.log.info(
				`[LessonChunk] Lesson ${lessonId} has no groundable text, skipping`,
			);
			return;
		}

		/* @info - Embed (CPU; model loads on first job) */
		const chunks = chunkText(text);
		const vectors = await EmbeddingService.getInstance().embedMany(chunks);
		if (vectors.length !== chunks.length) {
			throw new Error(
				`Embedding count mismatch for lesson ${lessonId} (${chunks.length} chunks, ${vectors.length} vectors)`,
			);
		}

		/* @info - Replace this lesson's rows (delete + re-insert, one transaction) */
		await db.transaction(async (tx) => {
			await tx.execute(
				sql`DELETE FROM lesson_chunks WHERE lesson_id = ${lessonId}`,
			);
			for (let i = 0; i < chunks.length; i++) {
				await tx.execute(
					sql`INSERT INTO lesson_chunks
						(course_id, lesson_id, lesson_type, content, embedding)
						VALUES (${courseId}, ${lessonId}, ${lesson.type}, ${chunks[i]},
							${EmbeddingService.toVectorLiteral(vectors[i])}::vector)`,
				);
			}
		});

		this.log.info(
			`[LessonChunk] Lesson ${lessonId} indexed: ${chunks.length} chunks (${JobNames.EMBED_LESSON})`,
		);
	}
}
