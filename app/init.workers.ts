/**
 * Worker process entry point. All BullMQ consumers are instantiated here.
 *
 * Run via:
 *   npm run start:dev:workers    (development)
 *   npm run start:prod:workers   (production)
 */

import { CacheService } from "@/services/cache.service";
import { EmailWorkerService } from "@/services/workers/email.worker.service";

// Trigger Redis connection
CacheService.getInstance();

console.log("[Workers] Initializing...");

// ── Register workers ──────────────────────────────────
EmailWorkerService.getInstance();

console.log("[Workers] All workers registered and listening.");

// Graceful shutdown
const shutdown = async () => {
	console.log("[Workers] Shutting down...");
	await CacheService.getInstance().close();
	process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
