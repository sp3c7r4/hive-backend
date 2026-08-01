import { BaseQueueService } from "@/bases/services/base.queue.service";
import { QueueNames } from "@/enums";
import { TTL } from "@/constants";
import { serviceLogger } from "@/utils";

interface SubscriptionExpiryJobData {
	idempotencyKey: string;
}

export class SubscriptionExpiryQueueService extends BaseQueueService<SubscriptionExpiryJobData> {
	private static instance: SubscriptionExpiryQueueService;

	private readonly log = serviceLogger("SubscriptionExpiryQueueService");

	private constructor() {
		super({
			queueName: QueueNames.SUBSCRIPTION_EXPIRY,
			alias: "SubscriptionExpiryQueue",
		});
	}

	static getInstance(): SubscriptionExpiryQueueService {
		if (!this.instance) {
			this.instance = new SubscriptionExpiryQueueService();
		}
		return this.instance;
	}

	async startRepeatingJob() {
		const queue = this.getQueue();
		await queue
			.add("scan-expired-subscriptions", { idempotencyKey: "cron:subscription-expiry" }, {
				repeat: { every: 60_000 },
				removeOnComplete: { age: TTL.IN_AN_HOUR, count: 100 },
				removeOnFail: { age: TTL.IN_24_HOURS },
			})
			.then(() => {
				this.log.info("Subscription expiry cron registered (every 60s)");
			})
			.catch((e) => {
				this.log.error("Failed to register subscription expiry cron", { error: e });
				throw e;
			});
	}
}
