import type { Redis } from "ioredis";
import { logger } from "@/utils";
import { CacheService } from "../cache.service";

export class PublisherService {
	private static instance: PublisherService;
	private readonly pub: Redis;

	private constructor() {
		const cacheService = CacheService.getInstance();
		this.pub = cacheService.getRedisClient().duplicate();
		this.pub.on("error", (err) => {
			logger.error(`Redis publisher error: ${err.message}`);
		});
	}

	static getInstance(): PublisherService {
		if (!this.instance) this.instance = new PublisherService();
		return this.instance;
	}

	/**
	 * @description Publishes a structured event to a Redis channel.
	 * Workers use this to notify SSE listeners about connection state changes.
	 *
	 * @param channel - The Redis pub/sub channel name
	 * @param event - The event type (e.g., WhatsappNotifications.PAIRING_QR)
	 * @param data - The event payload (will be JSON-stringified)
	 */
	async publish(channel: string, event: string, data: string) {
		const message = JSON.stringify({ event, data });
		await this.pub.publish(channel, message);
	}
}
