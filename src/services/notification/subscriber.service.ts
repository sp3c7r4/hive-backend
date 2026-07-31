import type { Redis } from "ioredis";
import { logger } from "@/utils";
import { CacheService } from "../cache.service";

export class SubscriberService {
	private static instance: SubscriberService;
	private readonly cacheService: CacheService = CacheService.getInstance();

	// # We create a new redis client for the subscriber to avoid interference with other Redis operations
	private readonly sub: Redis = this.cacheService
		.getRedisClient()
		.duplicate();

	private constructor() {
		this.sub.on("error", (err) => {
			logger.error(`Redis subscriber error: ${err.message}`);
		});
	}

	static getInstance(): SubscriberService {
		if (!this.instance) this.instance = new SubscriberService();
		return this.instance;
	}

	subscribe(channel: string, callback: (message: string) => void) {
		// # Subscribe to the specified channel
		this.sub.subscribe(channel, (err, count) => {
			if (err) {
				console.error("Failed to subscribe: ", err);
				return;
			}
			console.log(
				`Subscribed successfully! This client is currently subscribed to ${count} channels.`,
			);
		});

		// # Listen for messages on the subscribed channel
		this.sub.on("message", (channel, message) => {
			console.log(`Received message from channel ${channel}: ${message}`);
			callback(message);
		});
	}

	remove(channel: string) {
		this.sub.unsubscribe(channel, (err, count) => {
			if (err) {
				console.error("Failed to unsubscribe: ", err);
				return;
			}
			console.log(
				`Unsubscribed successfully! This client is currently subscribed to ${count} channels.`,
			);
		});
	}
}
