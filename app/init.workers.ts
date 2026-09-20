/**
 * Worker process entry point. All BullMQ consumers are instantiated here.
 *
 * Run via:
 *   npm run start:dev:workers    (development)
 *   npm run start:prod:workers   (production)
 */

import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { CacheService } from "@/services/cache.service";
import { BrowserEngine } from "@/services/engine/browser.engine";
import { LiveRecordingQueueService } from "@/services/queues/live-recording.queue.service";
import { CertificateWorkerService } from "@/services/workers/certificate.worker.service";
import { EmailWorkerService } from "@/services/workers/email.worker.service";
import { GradingWorkerService } from "@/services/workers/grading.worker.service";
import { LessonChunkWorkerService } from "@/services/workers/lesson-chunk.worker.service";
import { LiveRecordingWorkerService } from "@/services/workers/live-recording.worker.service";

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
	LiveRecordingWorkerService.getInstance();

	// ── Repeating jobs ────────────────────────────────────
	// The live recording poll (phase 5a): it is the only thing that flips a recording
	// row to ready/failed, so it must be scheduled by the worker process itself.
	await LiveRecordingQueueService.getInstance().startRepeatingJob();

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
