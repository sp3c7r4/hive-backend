import type { Job } from "bullmq";
import { and, eq, lt, isNotNull } from "drizzle-orm";
import { BaseWorkerService, RelationalRepository } from "@/bases";
import { PlanSubscriptionStatus, QueueNames, Status } from "@/enums";
import { subscription } from "@/models";
import { bot } from "@/modules/bot/bot.model";
import { business } from "@/modules/business/models/business.model";
import { PlanHandler } from "@/helpers/billing/plan.handler";
import { serviceLogger } from "@/utils";

/**
 * Cron-style worker that scans for expired subscriptions and transitions
 * them to PAST_DUE. Runs on a repeating schedule via BullMQ `repeat`.
 */
export class SubscriptionExpiryWorkerService extends BaseWorkerService<Record<string, any>> {
	private static instance: SubscriptionExpiryWorkerService;

	private readonly subRepo = new RelationalRepository(subscription);
	private readonly botRepo = new RelationalRepository(bot);
	private readonly bizRepo = new RelationalRepository(business);

	private readonly planHandler = PlanHandler.getInstance();
	private readonly log = serviceLogger("Subscription Expiry Worker");

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
			concurrency: 1, // single-file processing — no races
		});
	}

	protected async process(_job: Job) {
		const now = new Date();

		// Find all active subscriptions whose period has ended
		const expired = await this.subRepo.findMany(
			and(
				eq(subscription.status, PlanSubscriptionStatus.ACTIVE),
				isNotNull(subscription.currentPeriodEnd),
				lt(subscription.currentPeriodEnd, now),
			),
		);

		if (expired.length === 0) return;

		this.log.info(`Found ${expired.length} expired subscription(s)`);

		for (const sub of expired) {
			try {
				// Mark PAST_DUE
				await this.subRepo.updateWhere(
					eq(subscription.id, sub.id),
					{ status: PlanSubscriptionStatus.PAST_DUE } as any,
				);

				// Pause all active bots for this business
				const paused = await this.botRepo.updateWhere(
					and(
						eq(bot.businessId, sub.businessId),
						eq(bot.status, Status.ACTIVE),
					)!,
					{ status: Status.PAUSED, isActive: false } as any,
				);

				this.log.info(
					`Subscription ${sub.id} → PAST_DUE. Paused ${paused.length} bot(s) for business ${sub.businessId}`,
				);

				// Send trial-expired email
				const biz = await this.bizRepo.findById(sub.businessId);
				const businessName = biz?.name ?? "Your Business";

				await this.planHandler.sendTrialExpiredEmail(
					sub.businessId,
					businessName,
				);
			} catch (e: unknown) {
				this.log.error(
					`Failed to process expired subscription ${sub.id}`,
					{ error: e instanceof Error ? e.message : String(e) },
				);
			}
		}
	}
}
