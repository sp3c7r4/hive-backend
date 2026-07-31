import type { Job } from "bullmq";
import { BaseWorkerService } from "@/bases";
import { QueueNames } from "@/enums";
import { EmailService } from "@/services/mail.service";
import { logger } from "@/utils";

export class EmailWorkerService extends BaseWorkerService {
	private static instance: EmailWorkerService;

	/** @info - Services */
	private readonly emailService: EmailService;

	/**
	 * @info - Gets singleton instance
	 * @returns {EmailWorkerService}
	 */
	static getInstance() {
		if (!this.instance) {
			this.instance = new EmailWorkerService();
		}
		return this.instance;
	}

	private constructor(concurrency = 10) {
		super({
			queueName: QueueNames.EMAIL,
			alias: "EmailWorker",
			concurrency,
		});
		this.emailService = EmailService.getInstance();
	}

	protected async process(job: Job) {
		try {
			logger.info(`Processing email job ${job.id}`, {
				jobName: job.name,
				recipient: job.data?.message?.to,
			});
			const { message, template, locals } = job.data;

			await this.emailService.send({ message, template, locals });

			logger.info(`Email job ${job.id} processed successfully`);
		} catch (error: any) {
			logger.error(`Error processing email job ${job.id}`, {
				error: error.message,
				details: error.details || error.originalError?.details,
				stack: error.stack,
				recipient: job.data?.message?.to,
			});
			throw error;
		}
	}
}
