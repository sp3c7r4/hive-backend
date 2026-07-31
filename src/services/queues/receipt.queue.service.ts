import { BaseQueueService } from "@/bases/services/base.queue.service";
import { QueueNames, type GenerateReceiptOptions } from "@/enums";

export class ReceiptQueueService extends BaseQueueService<GenerateReceiptOptions> {
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
