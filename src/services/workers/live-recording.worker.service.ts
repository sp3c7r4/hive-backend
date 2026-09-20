import type { Job } from "bullmq";
import { BaseWorkerService } from "@/bases/services/base.worker.service";
import { QueueNames } from "@/enums";
import { LiveRecordingService } from "@/modules/live/live-recording.service";
import { serviceLogger } from "@/utils";

/**
 * @info - The only thing that flips a recording row (D-P5-3): lists the egresses this app
 * believes are running and converges each session - complete to `ready`, failed to the
 * partial file removed, past the cap to stopped, gone from LiveKit to stopped. The job body
 * is idempotent, so a double fire or a restart changes nothing twice (risk 3).
 */
export class LiveRecordingWorkerService extends BaseWorkerService<
	Record<string, never>
> {
	private static instance: LiveRecordingWorkerService;

	private readonly workerLog = serviceLogger("LiveRecordingWorker");

	static getInstance(): LiveRecordingWorkerService {
		if (!this.instance) this.instance = new LiveRecordingWorkerService();
		return this.instance;
	}

	private constructor() {
		super({
			queueName: QueueNames.LIVE_RECORDING,
			alias: "LiveRecordingWorker",
			/* @info - One at a time: the poll talks to LiveKit and writes rows conditionally,
			 * so a second concurrent pass buys nothing and only doubles the API calls. */
			concurrency: 1,
		});
	}

	protected override async process(_job: Job): Promise<void> {
		await LiveRecordingService.getInstance().pollRecordings();
		this.workerLog.info("Recording poll cycle complete");
	}
}
