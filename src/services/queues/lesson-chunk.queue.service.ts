import { BaseQueueService } from "@/bases/services/base.queue.service";
import { JobNames, QueueNames } from "@/enums";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import { lessons, modules } from "@/modules/courses/course.model";
import { logger } from "@/utils";

/**
 * @info - Shared trigger: re-index a lesson for the course tutor.
 * Resolves the course id from the lesson -> module chain and enqueues the
 * job. Safe to call after any lesson/quiz content mutation; published
 * groundable lessons only (the worker decides extractability).
 */
export const enqueueLessonForIndexing = async (lessonId: number) => {
	try {
		const db = getDb();
		const [lesson] = await db
			.select({ moduleId: lessons.moduleId, status: lessons.status })
			.from(lessons)
			.where(eq(lessons.id, lessonId))
			.limit(1);
		if (!lesson || lesson.status !== "published") return;
		const [module] = await db
			.select({ courseId: modules.courseId })
			.from(modules)
			.where(eq(modules.id, lesson.moduleId))
			.limit(1);
		if (!module) return;
		await LessonChunkQueueService.getInstance().queueLesson(
			lessonId,
			module.courseId,
		);
	} catch (e) {
		/* @info - Indexing is best-effort; never fail the lesson save */
		logger.error(`[Course] Could not enqueue lesson ${lessonId} for indexing`, e);
	}
};

export interface LessonChunkJobData {
	lessonId: number;
	courseId: number;
	idempotencyKey?: string;
}

/**
 * @info - Ingestion queue: extract -> chunk -> embed a published lesson.
 * Runs in the worker process (ONNX is CPU-heavy; never in the web process).
 */
export class LessonChunkQueueService extends BaseQueueService<LessonChunkJobData> {
	private static instance: LessonChunkQueueService;

	private constructor() {
		super({
			queueName: QueueNames.LESSON_CHUNK,
			alias: "LessonChunk",
			args: {
				/* @info - Embedding is CPU-bound; keep concurrency low in the worker */
				attempts: 3,
				backoff: { type: "exponential", delay: 5000 },
			},
		});
	}

	static getInstance(): LessonChunkQueueService {
		if (!this.instance) this.instance = new LessonChunkQueueService();
		return this.instance;
	}

	/** @info - Enqueue re-embedding for one lesson (delete + re-insert is idempotent) */
	queueLesson = (lessonId: number, courseId: number) => {
		return this.add(JobNames.EMBED_LESSON, { lessonId, courseId });
	};
}
