import { BaseQueueService } from "@/bases/services/base.queue.service";
import { EmailTemplates, QueueNames } from "@/enums";

export interface EmailJobData<L> {
	message: {
		to: string;
    subject: string;
    text?: string;
    cc?: string[];
    bcc?: string[];
    replyTo?: string;
	};
  template: EmailTemplates;
  locals: L;
  identifier?: string;
  idempotencyKey: string;
}

export class EmailQueueService extends BaseQueueService<
	EmailJobData<any>
> {
	private static instance: EmailQueueService;

	private constructor() {
		super({
			queueName: QueueNames.EMAIL,
			alias: "EmailQueue",
      args: { priority: 1 },

		});
	}

	static getInstance(): EmailQueueService {
		if (!this.instance) {
			this.instance = new EmailQueueService();
		}
		return this.instance;
	}
}
