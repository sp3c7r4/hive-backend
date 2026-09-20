import { RecordingStatus } from "@/enums";
import type { LiveSession } from "./live-session.model";

/**
 * @info - What a session's recording columns mean, derived rather than stored: the state
 * every surface reads (spec section 4). It lives in its own module because both sides of the
 * recording need it and they must not import each other - the recorder owns start/stop/the
 * poll, the session service owns the payload that carries the summary, and an import in both
 * directions is a cycle (the repo's `madge --circular` is a checked gate).
 */

/** @info - The bucket's own lifecycle rule deletes an object 90 days after it is written
 *  (spec fact 7). Expiry is derived from this, never stored: a flag would drift the moment
 *  the rule changes. */
const RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** @info - A session's recording as the recorder itself needs it. */
export interface LiveSessionRecordingState {
	sessionId: number;
	/** null means nothing was ever recorded; `deleted` means there was one and the host
	 *  removed it - deliberately different (spec section 4). */
	status: RecordingStatus | null;
	startedAt: Date | null;
	endedAt: Date | null;
	durationSeconds: number | null;
	/** Host-facing reason, only ever set while `failed` (D-P5-10). */
	error: string | null;
	/** Derived, never stored: `ready`, and older than the bucket's retention (D-P5-5). */
	expired: boolean;
}

/** @info - The column is a database enum (migration 0031), so a stored value is always one
 *  of the five - drizzle types every enum column in this repo as plain `string`. */
const toRecordingStatus = (value: string | null): RecordingStatus | null =>
	value === null ? null : (value as RecordingStatus);

export const recordingStateFor = (
	session: LiveSession,
	now: Date = new Date(),
): LiveSessionRecordingState => ({
	sessionId: session.id,
	status: toRecordingStatus(session.recordingStatus),
	startedAt: session.recordingStartedAt ?? null,
	endedAt: session.recordingEndedAt ?? null,
	durationSeconds: session.recordingDurationSeconds ?? null,
	error: session.recordingError ?? null,
	expired:
		session.recordingStatus === RecordingStatus.READY &&
		session.recordingStartedAt !== null &&
		now.getTime() - session.recordingStartedAt.getTime() >
			RETENTION_DAYS * DAY_MS,
});

/**
 * @info - The session payload's summary of its recording (5b): `status`, `durationSeconds`
 * and the derived `expired`. A state, never a URL - the URL is minted per request by the
 * playback endpoint (D-P5-2/D-P5-5 as amended), so nothing cached in a payload can outlive
 * the caller's access to it.
 */
export interface LiveSessionRecording {
	status: RecordingStatus;
	durationSeconds: number | null;
	expired: boolean;
}

/**
 * @info - `null` is "there is nothing to watch here", and it covers three different rows on
 * purpose: nothing was ever recorded; the host destroyed it (`deleted` renders as nothing -
 * D-P5-11, and it is neither an expiry nor a never-recorded, which is why the row keeps the
 * distinction even though the payload does not); or it failed and the caller is not the host
 * (`failed` is host-only - D-P5-10, because a half-recording offered to someone who paid is
 * worse than an honest silence).
 */
export const recordingSummaryFor = (
	session: LiveSession,
	access: { isHost: boolean },
): LiveSessionRecording | null => {
	const state = recordingStateFor(session);
	if (
		state.status === null ||
		state.status === RecordingStatus.DELETED ||
		(state.status === RecordingStatus.FAILED && !access.isHost)
	) {
		return null;
	}
	return {
		status: state.status,
		durationSeconds: state.durationSeconds,
		expired: state.expired,
	};
};
