/**
 * Worker process entry point. All BullMQ consumers are instantiated here.
 *
 * Run via:
 *   npm run start:dev:workers    (development)
 *   npm run start:prod:workers   (production)
 */

import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { BrowserEngine } from "@/services/engine/browser.engine";
import { CacheService } from "@/services/cache.service";
import { EmailWorkerService } from "@/services/workers/email.worker.service";
import { CertificateWorkerService } from "@/services/workers/certificate.worker.service";
import { LessonChunkWorkerService } from "@/services/workers/lesson-chunk.worker.service";
import { GradingWorkerService } from "@/services/workers/grading.worker.service";

// Trigger Redis + Postgres connections (the certificate worker queries the DB)
CacheService.getInstance();
connectPostgresDB(async () => {
	console.log("[Workers] Database connected");

	// ── Browser for document generation (certificates, receipts) ──
	await BrowserEngine.getInstance().start();

	// ── Register workers ──────────────────────────────────
	EmailWorkerService.getInstance();
	CertificateWorkerService.getInstance();
	LessonChunkWorkerService.getInstance();
	GradingWorkerService.getInstance();

	console.log("[Workers] All workers registered and listening.");
});
void getDb;

// Graceful shutdown
const shutdown = async () => {
	console.log("[Workers] Shutting down...");
	await CacheService.getInstance().close();
	process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
