/**
 * @info - Grading queue: one GRADE_SUBMISSION job per submission in a
 * mass-grading batch. Job data carries the batch id so the worker can
 * update batch counters and publish progress events.
 */
import { BaseQueueService } from "@/bases/services/base.queue.service";
import { JobNames, QueueNames } from "@/enums";

export interface GradingJobData {
	submissionId: number;
	batchId: number;
	instructorContext?: string;
	idempotencyKey?: string;
}

export class GradingQueueService extends BaseQueueService<GradingJobData> {
	private static instance: GradingQueueService;

	static getInstance(): GradingQueueService {
		if (!this.instance) this.instance = new GradingQueueService();
		return this.instance;
	}

	private constructor() {
		super({ queueName: QueueNames.GRADING, alias: "Grading" });
	}

	enqueueGrade = async (job: GradingJobData): Promise<void> => {
		await this.getQueue().add(JobNames.GRADE_SUBMISSION, job);
	};
}
