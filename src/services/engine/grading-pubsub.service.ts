/**
 * @info - Redis pub/sub fanout for grading batch progress. The worker
 * publishes per-batch events; the SSE route subscribes and forwards.
 * Mirrors ChatPubSubService: one duplicate subscriber per SSE connection.
 */
import type Redis from "ioredis";
import { CacheService } from "@/services/cache.service";
import { serviceLogger } from "@/utils";

export type GradingBatchEvent =
	| {
			type: "submission-graded";
			submissionId: number;
			score: number;
			completedCount: number;
			totalCount: number;
	  }
	| {
			type: "submission-failed";
			submissionId: number;
			failedCount: number;
			totalCount: number;
	  }
	| { type: "batch-complete" };

export class GradingPubSubService {
	private static instance: GradingPubSubService;
	private readonly log = serviceLogger("GradingPubSub");

	static getInstance(): GradingPubSubService {
		if (!this.instance) this.instance = new GradingPubSubService();
		return this.instance;
	}

	static channelFor = (batchId: number) => `grading-batch:${batchId}`;

	publish = async (batchId: number, event: GradingBatchEvent): Promise<void> => {
		try {
			const client = CacheService.getInstance().getRedisClient();
			await client.publish(
				GradingPubSubService.channelFor(batchId),
				JSON.stringify(event),
			);
		} catch (e) {
			this.log.warn(`Publish failed for batch ${batchId}`, e);
		}
	};

	/** @info - One duplicate subscriber per call; returns an unsubscribe fn. */
	createSubscriber = async (
		batchId: number,
		onMessage: (event: GradingBatchEvent) => void,
	): Promise<() => void> => {
		const client = CacheService.getInstance().getRedisClient();
		const subscriber = client.duplicate({ enableReadyCheck: false }) as Redis;
		const channel = GradingPubSubService.channelFor(batchId);

		subscriber.on("message", (_channel, message) => {
			try {
				onMessage(JSON.parse(message) as GradingBatchEvent);
			} catch {
				/* ignore malformed events */
			}
		});
		subscriber.on("error", (err) => {
			this.log.warn(`Subscriber error for batch ${batchId}: ${err.message}`);
		});

		await subscriber.subscribe(channel);
		return () => {
			subscriber.unsubscribe(channel).catch(() => {});
			subscriber.quit().catch(() => {});
		};
	};
}
