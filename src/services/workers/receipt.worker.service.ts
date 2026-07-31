import type { Job } from "bullmq";
import { BaseWorkerService } from "@/bases";
import { QueueNames, type GenerateReceiptOptions } from "@/enums";
import { logger } from "@/utils";
import { BaileysEngine } from "../engine/baileys.engine.service";
import { ReceiptGenerator } from "../receipt.generator.service";

export class ReceiptWorkerService extends BaseWorkerService<GenerateReceiptOptions> {
	private static instance: ReceiptWorkerService;

	/** @info - Services */
	private readonly receiptGeneratorService: ReceiptGenerator;

	/**
	 * @info - Gets singleton instance
	 * @returns {ReceiptWorkerService}
	 */
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

	protected async process(job: Job<GenerateReceiptOptions>) {
		try {
			logger.info(`Processing receipt job ${job.id}-[${job.name}] `, {
				data: job.data,
			});

			const receiptBuffer = await this.receiptGeneratorService.generateFile(
				job.data,
			);

			// Send WhatsApp confirmation if routing info is present
			const { connectionId, senderId, receiptNumber } = job.data;
			if (connectionId && senderId) {
				// Send text confirmation
				await BaileysEngine.sendMessage(connectionId, senderId, {
					text: `✅ Payment confirmed! Your order #${receiptNumber} has been received. Here's your receipt.`,
				});

				// Send the PDF receipt as a document
				await BaileysEngine.sendMessage(connectionId, senderId, {
					document: receiptBuffer,
					fileName: `receipt-${receiptNumber}.pdf`,
					mimetype: "application/pdf",
				});

				logger.info(
					`Receipt and confirmation sent to ${senderId} for order #${receiptNumber}`,
				);
			}

			logger.info(`Receipt job ${job.id} processed successfully`);
		} catch (error: any) {
			logger.error(`Error processing receipt job ${job.id}`, {
				error: error.message,
				details: error.details || error.originalError?.details,
				stack: error.stack,
			});
			throw error;
		}
	}
}
