import type { Job } from "bullmq";
import { BaseWorkerService } from "@/bases";
import { QueueNames } from "@/enums";
import { serviceLogger } from "@/utils";

/**
 * Cron-style worker that scans for expired subscriptions and transitions
 * them to PAST_DUE. Runs on a repeating schedule via BullMQ `repeat`.
 *
 * TODO: Wire up your actual subscription table and business logic.
 */
export class SubscriptionExpiryWorkerService extends BaseWorkerService<Record<string, any>> {
	private static instance: SubscriptionExpiryWorkerService;

	private readonly _log = serviceLogger("Subscription Expiry Worker");

	static getInstance() {
		if (!this.instance) {
			this.instance = new SubscriptionExpiryWorkerService();
		}
		return this.instance;
	}

	private constructor() {
		super({
			queueName: QueueNames.SUBSCRIPTION_EXPIRY,
			alias: "SubscriptionExpiryWorker",
			concurrency: 1,
		});
	}

	protected async process(_job: Job) {
		this._log.info("Subscription expiry scan triggered — implement your logic here");
	}
}
