import { BaseQueueService } from "@/bases/services/base.queue.service";
import { TTL } from "@/constants";
import { JobNames, QueueNames } from "@/enums";
import { serviceLogger } from "@/utils";

interface LiveRecordingJobData {
	idempotencyKey: string;
}

/** @info - D-P5-3: 15 seconds is the latency the poll exists to be good enough for - the
 *  UI shows `Processing…` meanwhile, and the window between stop and ready is one cycle. */
const POLL_INTERVAL_MS = 15_000;

/**
 * @info - The recording poll's queue (D-P5-3, phase 5a). A repeatable job, not a webhook:
 * no dashboard-configured URL per environment, no signature-verifying public route, and no
 * dev tunnel - the UI never learns which one is in play, so swapping in a webhook later does
 * not touch it.
 */
export class LiveRecordingQueueService extends BaseQueueService<LiveRecordingJobData> {
	private static instance: LiveRecordingQueueService;

	private readonly log = serviceLogger("LiveRecordingQueueService");

	private constructor() {
		super({
			queueName: QueueNames.LIVE_RECORDING,
			alias: "LiveRecordingQueue",
		});
	}

	static getInstance(): LiveRecordingQueueService {
		if (!this.instance) {
			this.instance = new LiveRecordingQueueService();
		}
		return this.instance;
	}

	/**
	 * @info - Registered on boot in app/init.workers.ts. The repeat key is fixed, so a
	 * worker restart does not stack a second schedule on top of the first (risk 3: the poll
	 * is the only thing that flips a row, and it must resume rather than leave a session
	 * stuck in `processing`).
	 */
	startRepeatingJob = async () => {
		const queue = this.getQueue();
		await queue
			.add(
				JobNames.POLL_LIVE_RECORDINGS,
				{ idempotencyKey: "cron:live-recording-poll" },
				{
					repeat: { every: POLL_INTERVAL_MS },
					removeOnComplete: { age: TTL.IN_AN_HOUR, count: 100 },
					removeOnFail: { age: TTL.IN_24_HOURS },
				},
			)
			.then(() => {
				this.log.info(
					`Live recording poll registered (every ${POLL_INTERVAL_MS / 1000}s)`,
				);
			})
			.catch((e) => {
				this.log.error("Failed to register the live recording poll", {
					error: e,
				});
				throw e;
			});
	};
}
