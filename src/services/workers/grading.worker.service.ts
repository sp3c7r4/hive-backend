/**
 * @info - GradingWorkerService: GRADE_SUBMISSION jobs. Grades one
 * submission, atomically bumps the batch counters, publishes progress
 * events, and finalizes the batch when the last job lands. Concurrency 3
 * stays below the DeepSeek rate limit.
 */
import type { Job } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import { logger } from "@/utils";
import { BaseWorkerService } from "@/bases/services/base.worker.service";
import { JobNames, QueueNames } from "@/enums";
import { gradingBatches } from "@/modules/ai-grading/ai-grading.model";
import { GradingService } from "@/services/ai/grading.service";
import { GradingPubSubService } from "@/services/engine/grading-pubsub.service";
import type { GradingJobData } from "@/services/queues/grading.queue.service";

export class GradingWorkerService extends BaseWorkerService<GradingJobData> {
	private static instance: GradingWorkerService;
	private readonly workerLog = logger;

	static getInstance(): GradingWorkerService {
		if (!this.instance) this.instance = new GradingWorkerService();
		return this.instance;
	}

	private constructor() {
		super({
			queueName: QueueNames.GRADING,
			alias: "GradingWorker",
			concurrency: 3,
		});
	}

	private readonly grading = GradingService.getInstance();
	private readonly pubsub = GradingPubSubService.getInstance();

	protected override async process(job: Job<GradingJobData>): Promise<void> {
		const { submissionId, batchId, instructorContext } = job.data;

		try {
			const suggestion = await this.grading.gradeSubmission(submissionId, {
				instructorContext,
				batchId,
			});
			if (!suggestion) {
				/* No text to grade: count it failed so the batch can finish */
				await this.grading.recordFailure(submissionId, {
					instructorContext,
					batchId,
				});
				const batch = await this.incrementBatch(batchId, "failed");
				await this.pubsub.publish(batchId, {
					type: "submission-failed",
					submissionId,
					failedCount: batch.failedCount,
					totalCount: batch.totalCount,
				});
				await this.maybeFinalize(batch);
				return;
			}

			/* Atomic: increment and read the new counts in one statement */
			const batch = await this.incrementBatch(batchId, "completed");
			await this.pubsub.publish(batchId, {
				type: "submission-graded",
				submissionId,
				score: suggestion.score,
				completedCount: batch.completedCount,
				totalCount: batch.totalCount,
			});
			await this.maybeFinalize(batch);
		} catch (err) {
			this.workerLog.error(
				`[Grading] Job failed for submission ${submissionId}`,
				err,
			);
			await this.grading.recordFailure(submissionId, {
				instructorContext,
				batchId,
			});
			const batch = await this.incrementBatch(batchId, "failed");
			await this.pubsub.publish(batchId, {
				type: "submission-failed",
				submissionId,
				failedCount: batch.failedCount,
				totalCount: batch.totalCount,
			});
			await this.maybeFinalize(batch);
		}
	}

	private async incrementBatch(batchId: number, field: "completed" | "failed") {
		const batchSet =
			field === "completed"
				? { completedCount: sql`${gradingBatches.completedCount} + 1` }
				: { failedCount: sql`${gradingBatches.failedCount} + 1` };
		const [batch] = await getDb()
			.update(gradingBatches)
			.set(batchSet)
			.where(eq(gradingBatches.id, batchId))
			.returning();
		return batch!;
	}

	/** @info - Finalize only when this increment brought the sum to total.
	 * Idempotent (WHERE status = 'running') so a duplicate can't double-write. */
	private async maybeFinalize(batch: {
		id: number;
		totalCount: number;
		completedCount: number;
		failedCount: number;
	}) {
		if (batch.completedCount + batch.failedCount !== batch.totalCount) return;
		await getDb()
			.update(gradingBatches)
			.set({
				status: batch.failedCount > 0 ? "completed_with_errors" : "completed",
				completedAt: new Date(),
			})
			.where(
				and(
					eq(gradingBatches.id, batch.id),
					sql`${gradingBatches.status} = 'running'`,
				),
			);
		await this.pubsub.publish(batch.id, { type: "batch-complete" });
	}
}
