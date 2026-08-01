import type { Job } from "bullmq";
import { IdempotentWorkerService } from "@/bases";
import { QueueNames, type GenerateReceiptOptions } from "@/enums";
import { logger } from "@/utils";
import { ReceiptGenerator } from "../receipt.generator.service";

export class ReceiptWorkerService extends IdempotentWorkerService<GenerateReceiptOptions & { idempotencyKey?: string }> {
	private static instance: ReceiptWorkerService;

	/** @info - Services */
	private readonly receiptGeneratorService: ReceiptGenerator;

	static getInstance() {
		if (!this.instance) {
			this.instance = new ReceiptWorkerService();
		}
		return this.instance;
	}

	private constructor(concurrency = 10) {
		super({
			queueName: QueueNames.RECEIPT,
			alias: "ReceiptWorker",
			concurrency,
		});
		this.receiptGeneratorService = ReceiptGenerator.getInstance();
	}

	protected async idempotentProcess(job: Job<GenerateReceiptOptions>) {
		try {
			logger.info(`Processing receipt job ${job.id}-[${job.name}] `, {
				data: job.data,
			});

			const receiptBuffer = await this.receiptGeneratorService.generateFile(
				job.data,
			);

			// TODO: Send receipt via preferred channel (email, WhatsApp, etc.)
			// The connectionId/senderId metadata on job.data can be used for routing.

			logger.info(`Receipt job ${job.id} processed successfully`);
		} catch (error: any) {
			logger.error(`Error processing receipt job ${job.id}`, {
				error: error.message,
				stack: error.stack,
			});
			throw error;
		}
	}
}
