/**
 * Worker process entry point. All BullMQ consumers are instantiated here.
 *
 * Run via:
 *   npm run start:dev:workers    (development)
 *   npm run start:prod:workers   (production)
 */

import { config } from "@/config/config";
import { CacheService } from "@/services/cache.service";

const cacheService = new CacheService(config.redis.uri);

console.log("[Workers] Initializing...");

// ── Register workers here ───────────────────────────────
// new EmailWorkerService(cacheService);
// new CertificateWorkerService(cacheService);

console.log("[Workers] All workers registered and listening.");

// Graceful shutdown
const shutdown = async () => {
	console.log("[Workers] Shutting down...");
	await cacheService.close();
	process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
