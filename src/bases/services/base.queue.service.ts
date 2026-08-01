import { type JobsOptions, Queue, QueueEvents } from "bullmq";
import { randomUUID } from "node:crypto";
import { TTL } from "@/constants";
import { CacheService } from "@/services/cache.service";
import { logger } from "@/utils";

interface BaseQueueOptions {
	queueName: string;
	alias: string;
	args?: JobsOptions;
}

export class BaseQueueService<T extends { idempotencyKey?: string }> {
	/** @info - Services */
	private readonly cacheService: CacheService;

	private queue: Queue;
	private queueEvents: QueueEvents;

	private alias: string;
	private jobOptions: JobsOptions;

	constructor(options: BaseQueueOptions) {
		if (!options.queueName || !options.alias)
			throw new Error("Queue name and alias are required.");

		this.cacheService = CacheService.getInstance();

		this.queue = new Queue(options.queueName, {
			connection: this.cacheService.getConnectionOptions(),
		});

		this.queueEvents = new QueueEvents(options.queueName, {
			connection: this.cacheService.getConnectionOptions(),
		});

		this.alias = `${options.alias[0] + options.alias.slice(1)}`;
		this.jobOptions = options.args || {};

		this._setupJobListeners();
	}

	getQueue = () => {
		return this.queue;
	};

	_setupJobListeners = () => {
		this.queueEvents.on("failed", async ({ jobId, failedReason }) => {
			logger.error(`${this.alias} job ${jobId} failed: ${failedReason}`);
		});
	};

	add = async (jobName: string, data: T) => {
		/** @info - Generate idempotency key if caller didn't provide one */
		const key = data.idempotencyKey ?? `${jobName}:${randomUUID()}`;

		await this.queue.add(jobName, { ...data, idempotencyKey: key }, {
			attempts: 3,
			backoff: {
				type: "exponential",
				delay: 2000,
			},
			removeOnComplete: {
				age: TTL.IN_AN_HOUR,
				count: 1000,
			},
			removeOnFail: {
				age: TTL.IN_24_HOURS,
			},
			deduplication: { id: key },
			...this.jobOptions,
		});
	};
}
