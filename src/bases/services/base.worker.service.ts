import { type Job, Worker } from "bullmq";
import { CacheService } from "@/services/cache.service";
import { logger, serviceLogger } from "@/utils";

export interface BaseWorkerOptions {
	queueName: string;
	alias: string;
	concurrency?: number;
	lockDuration?: number;
	maxStalledCount?: number;
}

/**
 * @class BaseWorkerService
 * @description Abstract base class for BullMQ workers. Provides standardized
 * worker setup, event logging, graceful shutdown, and error handling.
 * Subclasses implement the `process` method to define job-specific logic.
 *
 * @example
 * class EmailWorker extends BaseWorkerService {
 *   constructor() {
 *     super({ queueName: "email", alias: "Email" });
 *   }
 *
 *   protected async process(job: Job<T>) {
 *     await emailService.send(job.data);
 *   }
 * }
 */
export abstract class BaseWorkerService<T> {
	private readonly worker: Worker;
  private readonly alias: string;


  /** @info - Services */
  private readonly cacheService: CacheService;


  /** @info - Utilities */
  private readonly log;

	/**
	 * @description Initializes the BullMQ worker with the given options.
	 * Registers event listeners for job lifecycle events and graceful shutdown.
	 *
	 * @param {BaseWorkerOptions} options - Worker configuration
	 * @param {string} options.queueName - The BullMQ queue name to consume from
	 * @param {string} options.alias - Human-readable name for logging
	 * @param {number} [options.concurrency=10] - Max concurrent jobs
	 * @param {number} [options.lockDuration=60000] - Max ms before a job is considered stalled
	 * @param {number} [options.maxStalledCount=1] - Max stall retries before failure
	 */
	constructor(options: BaseWorkerOptions) {
		const {
			queueName,
			alias,
			concurrency = 10,
			lockDuration = 60_000,
			maxStalledCount = 1,
		} = options;

    this.alias = alias;
    this.log = serviceLogger(this.alias.toUpperCase())
		this.cacheService = CacheService.getInstance();

		this.worker = new Worker(queueName, async (job) => this.handle(job), {
			concurrency,
			connection: this.cacheService.getConnectionOptions(),
			lockDuration,
			maxStalledCount,
			removeOnComplete: { age: 3_600, count: 1_000 },
			removeOnFail: { age: 86_400 },
		});

		this.registerListeners();
		this.registerShutdown();
	}

	/**
	 * @description Abstract method that subclasses must implement.
	 * Contains the actual job processing logic.
	 *
	 * @param {Job<T>} job - The BullMQ job to process
	 * @returns {Promise<void>}
	 * @protected
	 * @abstract
	 */
		/** Subclasses implement this with job-specific logic. */
  protected abstract process(job: Job<T>): Promise<any>;

	/**
	 * @description Wraps the subclass `process` method with logging and error handling.
	 *
	 * @param {Job<T>} job - The BullMQ job to handle
	 * @returns {Promise<void>}
	 * @private
	 */
	private async handle(job: Job<T>): Promise<void> {
		try {
			logger.info(`[${this.alias}] Processing job ${job.id}`, {
				name: job.name,
				attempt: job.attemptsMade + 1,
			});

			await this.process(job);

			logger.info(`[${this.alias}] Job ${job.id} completed`);
		} catch (error: any) {
			logger.error(`[${this.alias}] Job ${job.id} failed`, {
				error: error.message,
				stack: error.stack,
				data: job.data,
			});
			throw error;
		}
	}

	/**
	 * @description Registers BullMQ worker event listeners for lifecycle logging.
	 *
	 * @returns {void}
	 * @private
	 */
	private registerListeners() {
		this.worker.on("ready", () => {
			logger.info(`[${this.alias}] Worker ready`);
		});

		this.worker.on("active", (job) => {
			logger.info(`[${this.alias}] Job ${job.id} active`);
		});

		this.worker.on("stalled", (jobId) => {
			logger.warn(`[${this.alias}] Job ${jobId} stalled`);
		});

		this.worker.on("error", (error) => {
			logger.error(`[${this.alias}] Worker error`, error);
		});
	}

	/**
	 * @description Registers SIGTERM and SIGINT handlers for graceful shutdown.
	 * Ensures in-progress jobs complete before the worker closes.
	 *
	 * @returns {void}
	 * @private
	 */
	private registerShutdown() {
		const shutdown = async () => {
			logger.info(`[${this.alias}] Shutting down...`);
			await this.stop();
			process.exit(0);
		};

		process.on("SIGTERM", shutdown);
		process.on("SIGINT", shutdown);
	}

	/**
	 * @description Gracefully stops the worker, allowing in-progress jobs to complete.
	 *
	 * @returns {Promise<void>}
	 */
	async stop() {
		await this.worker.close();
		logger.info(`[${this.alias}] Worker stopped`);
	}
}
