/**
 * Idempotent worker base. Extends BaseWorkerService with a distributed lock
 * to prevent duplicate processing across retries or multi-instance deployments.
 *
 * Your job data MUST include an `idempotencyKey` field.
 *
 * TODO: Rewire after CacheService grows a proper acquireLock() method.
 */

import type { Job } from "bullmq";
import { CacheService } from "@/services/cache.service";
import { BaseWorkerService, type BaseWorkerOptions } from "./base.worker.service";

export abstract class IdempotentWorkerService<
	T extends { idempotencyKey?: string } = any,
> extends BaseWorkerService<T> {
	private readonly cache: CacheService;

	constructor(options: BaseWorkerOptions) {
		super(options);
		this.cache = CacheService.getInstance();
	}

	/** Override this instead of process(). */
	protected abstract idempotentProcess(job: Job<T>): Promise<void>;

	protected override async process(job: Job<T>): Promise<void> {
		/** @info - Fall back to job.id if no idempotency key provided */
		const key = job.data.idempotencyKey ?? job.id ?? `unknown:${Date.now()}`;
		const lockKey = `job:lock:${key}`;

		const acquired = await this.cache.redis.set(
			lockKey,
			"processing",
			"EX",
			300,
			"NX",
		);

		if (!acquired) {
			console.log(
				JSON.stringify({
					event: "job_skipped_duplicate",
					jobId: job.id,
					idempotencyKey: key,
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
