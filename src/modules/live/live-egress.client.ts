import {
	EgressClient,
	EgressStatus,
	EncodedFileOutput,
	EncodedFileType,
	EncodingOptionsPreset,
	S3Upload,
} from "livekit-server-sdk";
import { config } from "@/config";

/**
 * @info - LiveKit's egress API: the recorder that writes a session's room to one MP4 in
 * the private recordings bucket. It lives in its own module for the same reason
 * `live-room.client.ts` does - so tests can stand in a mock for one import, and so the
 * SDK's types stay out of the service. Egress is genuinely enabled on the shared project,
 * which is exactly why every test mocks this module: nothing here may run for real in a
 * test.
 *
 * `config.livekit.url` is the API URL (ws:// or wss://); EgressClient talks http(s) to the
 * same host. `publicUrl` is the browser-facing one and is deliberately not used here.
 *
 * Only three calls are ever made here - startRoomCompositeEgress, stopEgress and
 * listEgress (D-P5-1, D-P5-3): no track egress, no participant egress, no webhooks.
 */
const httpHost = (url: string): string => url.replace(/^ws/, "http");

let client: EgressClient | null = null;

const getEgressClient = (): EgressClient => {
	if (!client) {
		client = new EgressClient(
			httpHost(config.livekit.url),
			config.livekit.apiKey,
			config.livekit.apiSecret,
		);
	}
	return client;
};

/** @info - Egress as this app thinks about it: the LiveKit states, renamed, so the poll
 *  does not read LiveKit's enum order. */
export type EgressState =
	| "starting"
	| "active"
	| "ending"
	| "complete"
	| "failed"
	| "aborted"
	| "limit_reached"
	| "unknown";

const toEgressState = (status: EgressStatus): EgressState => {
	switch (status) {
		case EgressStatus.EGRESS_STARTING:
			return "starting";
		case EgressStatus.EGRESS_ACTIVE:
			return "active";
		case EgressStatus.EGRESS_ENDING:
			return "ending";
		case EgressStatus.EGRESS_COMPLETE:
			return "complete";
		case EgressStatus.EGRESS_FAILED:
			return "failed";
		case EgressStatus.EGRESS_ABORTED:
			return "aborted";
		case EgressStatus.EGRESS_LIMIT_REACHED:
			return "limit_reached";
		default:
			return "unknown";
	}
};

/** @info - What the recorder needs to know about one egress. Times are milliseconds
 *  because LiveKit reports nanoseconds and the poll only compares them to a deadline. */
export interface EgressInfoSummary {
	egressId: string;
	roomName: string;
	state: EgressState;
	startedAt: Date | null;
	endedAt: Date | null;
	durationSeconds: number | null;
	error: string | null;
}

/** @info - LiveKit reports int64 nanoseconds; epoch 0 means "not set". */
const toDate = (nanoseconds: bigint | undefined): Date | null =>
	nanoseconds ? new Date(Number(nanoseconds / 1_000_000n)) : null;

const toSummary = (
	info: Awaited<ReturnType<EgressClient["listEgress"]>>[number],
): EgressInfoSummary => {
	const startedAt = toDate(info.startedAt);
	const endedAt = toDate(info.endedAt);
	const reported = info.fileResults[0]?.duration;
	return {
		egressId: info.egressId,
		roomName: info.roomName,
		state: toEgressState(info.status),
		startedAt,
		endedAt,
		/* @info - the file's own duration when LiveKit reports one, otherwise the span
		 * between start and end - the host-facing "minutes logged" (D-P5-16). */
		durationSeconds:
			reported && reported > 0n
				? Number(reported / 1_000_000_000n)
				: startedAt && endedAt
					? Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)
					: null,
		error: info.error || null,
	};
};

/**
 * @info - One MP4, straight into the private recordings bucket (D-P5-5/D-P5-7): a room
 * composite is a single file like a call recording, and the bucket is private by
 * construction, so playback will be presigned (phase 5b). The credentials, region and
 * bucket are the ones already in config - proven to write to the recordings bucket before
 * this phase was built. The key is passed in whole; this module never invents one.
 */
export const recordingFileOutput = (filepath: string): EncodedFileOutput =>
	new EncodedFileOutput({
		fileType: EncodedFileType.MP4,
		filepath,
		output: {
			case: "s3",
			value: new S3Upload({
				accessKey: config.aws.accessKeyId,
				secret: config.aws.secretAccessKey,
				region: config.aws.region,
				bucket: config.recordings.bucket,
				/* @info - AWS proper needs no endpoint; a local/emulated S3 does. */
				...(config.aws.s3Endpoint
					? { endpoint: config.aws.s3Endpoint, forcePathStyle: true }
					: {}),
			}),
		},
	});

/** @info - Starts the recorder on a room the caller has already authorised. */
export const startRoomRecording = async (
	roomName: string,
	filepath: string,
): Promise<{ egressId: string }> => {
	const info = await getEgressClient().startRoomCompositeEgress(
		roomName,
		recordingFileOutput(filepath),
		/* @info - 1080p30 H.264: MP4 that a browser plays without a transcode step. */
		{ encodingOptions: EncodingOptionsPreset.H264_1080P_30 },
	);
	return { egressId: info.egressId };
};

/** @info - Asks LiveKit to finish. The call returning does not mean the file is written -
 *  that is what the row's `processing` state is for. */
export const stopRoomRecording = async (egressId: string): Promise<void> => {
	await getEgressClient().stopEgress(egressId);
};

/** @info - The egresses LiveKit still knows about for one id. An empty array is the poll's
 *  "LiveKit has forgotten this recording" signal (trigger 4). */
export const listRoomRecordings = async (
	egressId: string,
): Promise<EgressInfoSummary[]> => {
	const infos = await getEgressClient().listEgress({ egressId });
	return infos.map(toSummary);
};
