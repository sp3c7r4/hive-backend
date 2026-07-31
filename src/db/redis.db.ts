import { CacheService } from "@/services/cache.service";
import { logger } from "@/utils";

const cacheService = CacheService.getInstance();

export const connectRedisDB = async () => {
	try {
		const client = cacheService.getRedisClient();
		logger.info("Connected to Redis ⚡");

		await client.ping((err, msg) => {
			if (err) {
				logger.error(
					`Error pinging Redis: ${err instanceof Error ? err.message : "Unknown error"}`,
				);
				process.exit(1);
			}
			logger.info(`Redis ping response: ${msg}`);
		});

		return client;
	} catch (e: unknown) {
		logger.error(
			`Error connecting to Redis: ${e instanceof Error ? e.message : "Unknown error"}`,
		);
		return null;
	}
};
