import type { Job } from "bullmq";
import { IdempotentWorkerService } from "@/bases";
import { QueueNames } from "@/enums";
import { EmailService } from "@/services/mail.service";
import { logger } from "@/utils";

interface EmailJobData {
	message: {
		to: string;
		subject: string;
		text?: string;
		cc?: string[];
		bcc?: string[];
		replyTo?: string;
	};
	template: string;
	locals: Record<string, any>;
	identifier?: string;
	idempotencyKey?: string;
}

export class EmailWorkerService extends IdempotentWorkerService<EmailJobData> {
	private static instance: EmailWorkerService;

	private readonly emailService: EmailService;

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

	protected async idempotentProcess(job: Job<EmailJobData>) {
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
				stack: error.stack,
				recipient: job.data?.message?.to,
			});
			throw error;
		}
	}
}
