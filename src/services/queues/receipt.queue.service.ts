import { BaseQueueService } from "@/bases/services/base.queue.service";
import { QueueNames, type GenerateReceiptOptions } from "@/enums";

export interface ReceiptJobData extends GenerateReceiptOptions {
	idempotencyKey: string;
}

export class ReceiptQueueService extends BaseQueueService<ReceiptJobData> {
	private static instance: ReceiptQueueService;

	private constructor() {
		super({
			queueName: QueueNames.RECEIPT,
			alias: "ReceiptQueue",
			args: { priority: 1 },
		});
	}

	static getInstance(): ReceiptQueueService {
		if (!this.instance) {
			this.instance = new ReceiptQueueService();
		}
		return this.instance;
	}
}
