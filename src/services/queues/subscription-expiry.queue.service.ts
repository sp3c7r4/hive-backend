import { BaseQueueService } from "@/bases/services/base.queue.service";
import { QueueNames } from "@/enums";
import { TTL } from "@/constants";
import { serviceLogger } from "@/utils";

/**
 * Registers a repeating BullMQ job that triggers the subscription expiry scan.
 * Call `SubscriptionExpiryQueueService.getInstance().startRepeatingJob()`
 * once at app bootstrap and the cron runs every 60 seconds automatically.
 */
export class SubscriptionExpiryQueueService extends BaseQueueService<{}> {
	private static instance: SubscriptionExpiryQueueService;

	/** @info - Utilities */
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

	/**
	 * Call once at bootstrap. Idempotent — BullMQ deduplicates repeatable
	 * jobs by name, so calling this multiple times won't create duplicates.
	 */
	async startRepeatingJob() {
		const queue = this.getQueue();
		await queue
			.add("scan-expired-subscriptions", {}, {
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
