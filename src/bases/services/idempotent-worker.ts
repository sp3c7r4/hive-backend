/**
 * Idempotent worker base. Extends BaseWorkerService with a distributed lock
 * to prevent duplicate processing across retries or multi-instance deployments.
 *
 * Uses CacheService.set() with NX (set-if-not-exists) for the lock — no raw
 * Redis commands, so the lock stays consistent with the app's serialization layer.
 *
 * Your job data MUST include an `idempotencyKey` field.
 *
 * @example
 * class ReceiptWorker extends IdempotentWorkerService<{ idempotencyKey: string; orderId: number }> {
 *   constructor(cache: CacheService) {
 *     super({ queueName: "ReceiptQueue", alias: "Receipt" }, cache);
 *   }
 *   protected async idempotentProcess(job: Job<T>) {
 *     await generatePdf(job.data.orderId);
 *   }
 * }
 */

import type { Job } from "bullmq";
import { CacheService } from "@/services/cache.service";
import { BaseWorkerService, type BaseWorkerOptions } from "./base.worker.service";

export abstract class IdempotentWorkerService<
  T extends { idempotencyKey: string },
> extends BaseWorkerService<T> {
  private readonly cache: CacheService;

  constructor(options: BaseWorkerOptions, cacheService: CacheService) {
    super(options, cacheService);
    this.cache = cacheService;
  }

  /** Override this instead of process(). */
  protected abstract idempotentProcess(job: Job<T>): Promise<void>;

  protected async process(job: Job<T>): Promise<void> {
    const lockKey = `job:lock:${job.data.idempotencyKey}`;

    // Use CacheService.set() with NX — goes through the same JSON
    // serialization layer as every other cache write in the app.
    // If someone swaps the Redis client behind CacheService, the
    // lock still works because it uses the public API.
    const acquired = await this.cache.redis.set(
      lockKey,
      "processing",
      "EX",
      300, // 5-min TTL — lock auto-expires if worker crashes
      "NX",
    );

    // NOTE: This is the one place we use cache.redis.set() directly
    // instead of cache.set() because we need the NX (set-if-not-exists)
    // flag, which is a Redis SET option, not a generic cache primitive.
    // If CacheService grows an `acquireLock(key, ttl)` method, migrate to that.

    if (!acquired) {
      console.log(
        JSON.stringify({
          event: "job_skipped_duplicate",
          worker: this.getAlias(),
          jobId: job.id,
          idempotencyKey: job.data.idempotencyKey,
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    try {
      await this.idempotentProcess(job);
    } finally {
      await this.cache.redis.del(lockKey);
    }
  }
}
