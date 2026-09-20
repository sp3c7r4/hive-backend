import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { config } from "@/config";
import { TTL } from "@/constants";
import { getDb } from "@/db/postgres.db";
import { RecordingStatus } from "@/enums";
import {
	throwBadRequestError,
	throwConflictError,
	throwForbiddenError,
	throwGoneError,
	throwNotFoundError,
} from "@/helpers/errors/throw-errors";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { StorageService } from "@/services/storage.service";
import { serviceLogger } from "@/utils";
import {
	type EgressInfoSummary,
	listRoomRecordings,
	startRoomRecording,
	stopRoomRecording,
} from "./live-egress.client";
import {
	type LiveSessionRecordingState,
	recordingStateFor,
} from "./live-recording.state";
import {
	type LiveSession,
	liveSessions,
	type NewLiveSession,
} from "./live-session.model";
import { LiveSessionService, roomNameForSession } from "./live-session.service";

const NOT_LIVE = "This session has not started yet.";
const ALREADY_RECORDING = "This session is already being recorded.";
const ALREADY_RECORDED = "This session already has a recording.";
const NOT_RECORDING = "This session is not being recorded.";
/** @info - The host-facing reasons (D-P5-10). Plain words: this reaches a person, not a log. */
const EGRESS_FAILED = "The recording failed before it could be saved.";
const ROOM_GONE = "The session's room closed before the recording finished.";
const RECORDING_LOST =
	"LiveKit stopped reporting this recording before it finished.";

/** @info - Playback (5b). */
const NO_RECORDING = "This session has no recording.";
const RECORDING_NOT_READY =
	"The recording is still being written. Try again in a moment.";
const RECORDING_EXPIRED = "This recording has expired (90-day retention).";
const DOWNLOAD_IS_MANAGING_SIDE =
	"Downloading a recording is for the host, the course instructor or a community owner/admin.";
const STOP_BEFORE_DELETING = "Stop the recording before deleting it.";

/** @info - D-P5-9's floor: `durationMinutes` is only ever as trustworthy as the form that
 *  produced it, so a 0 (or a 5) must not cut a real class off at the hour mark. */
const CAP_FLOOR_MINUTES = 60;
/** @info - The hour of grace past the session's own length: a class that runs over is
 *  normal, a recorder left running overnight is an incident. */
const CAP_GRACE_MINUTES = 60;
/** @info - A claim younger than this is a start whose LiveKit call has not returned yet, not
 *  a lost recorder. The claim is written before the call, and the poll runs every 15 seconds
 *  in a different process - so a tick landing inside that window (review finding B1) failed
 *  the row while the egress was still being created: the id was then stored nowhere, the cap
 *  could never reach that recorder, and the host's own stop answered 409. A claim older than
 *  any plausible start call is a crash between the two, and still converges. */
const START_CLAIM_GRACE_MS = 60_000;

/**
 * @info - How long a recording may run: the session's own length, floored at an hour,
 * plus an hour (D-P5-9). Never less than 120 minutes, whoever filled in the form.
 */
export const recordingCapMinutes = (durationMinutes: number): number =>
	Math.max(durationMinutes, CAP_FLOOR_MINUTES) + CAP_GRACE_MINUTES;

/**
 * @info - Where one session's recording lives: `{prefix}/session-{id}/recording.mp4`
 * (D-P5-7). Derived from the immutable session id, like the room name, so a deploy cannot
 * strand a file by recomputing a different key - and the fixed filename is what makes a
 * retry after a failure overwrite the failed attempt (D-P5-4) instead of leaving two files
 * for one session.
 */
export const recordingKeyFor = (sessionId: number): string =>
	`${config.recordings.keyPrefix}/session-${sessionId}/recording.mp4`;

/** @info - A recording that is running or finishing: the two states in which a start is
 *  refused and a second egress must not be created. */
export const isRecordingActive = (
	status: LiveSession["recordingStatus"],
): boolean =>
	status === RecordingStatus.RECORDING || status === RecordingStatus.PROCESSING;

/** @info - How a caller wants the bytes delivered: `inline` plays in the page, `attachment`
 *  saves the file. The one flag the download rule turns on (D-P5-5 as amended). */
export type RecordingDisposition = "inline" | "attachment";

/**
 * @info - The name a downloaded recording saves as, so it is recognisable in a downloads
 * folder. Everything outside a conservative set is dropped: the value becomes a response
 * header inside a signed URL, where a quote or a newline would break the signature (or the
 * header), and the title is author-supplied text.
 */
const downloadFilenameFor = (session: LiveSession): string => {
	const safe = session.title
		.replace(/[^a-zA-Z0-9 ._-]/g, "")
		.trim()
		.replace(/[ .]+/g, "-");
	return `${safe || `session-${session.id}`}.mp4`;
};

/**
 * @info - Capture (phase 5a). One recording per session, host-started, host-stopped, and
 * converged by a poll rather than a webhook (D-P5-3): start, stop, the cap and a room that
 * vanished are all this module's job, and nothing here ever starts a recording by itself
 * (D-P5-15).
 *
 * The authorization is not here - `loadForHostAction` is, so the gate order is the one the
 * go-live and moderation endpoints already use: session, access, host, native kind, live
 * status, and only then LiveKit. A non-host cannot cause a single egress call.
 */
export class LiveRecordingService {
	private static instance: LiveRecordingService;
	private readonly log = serviceLogger("LiveRecording");
	private readonly sessions = LiveSessionService.getInstance();

	static getInstance(): LiveRecordingService {
		if (!this.instance) this.instance = new LiveRecordingService();
		return this.instance;
	}

	/* ── Start ───────────────────────────────────────────────────────── */

	/** @info - POST /live/sessions/:sessionId/recording/start */
	startRecording = async (
		authData: IAuthData,
		sessionId: number,
	): Promise<LiveSessionRecordingState> => {
		const { session } = await this.sessions.loadForHostAction(
			authData,
			sessionId,
		);
		if (session.status !== "live") throwBadRequestError(NOT_LIVE);
		if (isRecordingActive(session.recordingStatus)) {
			throwConflictError(ALREADY_RECORDING);
		}
		if (
			session.recordingStatus === RecordingStatus.READY ||
			session.recordingStatus === RecordingStatus.DELETED
		) {
			/* @info - One recording per session (D-P5-4): only a failure may be retried, so
			 * pressing record again can never replace a file students can watch. */
			throwConflictError(ALREADY_RECORDED);
		}

		const key = recordingKeyFor(session.id);
		/* @info - The row is claimed before LiveKit is called, conditionally, so a
		 * double-click cannot start two egresses that both believe they own this session.
		 * Losing the claim is the same refusal as the check above, and costs no LiveKit call
		 * - the id is only stored on the row that won. */
		const claimed = await this.claimRow(session.id, key);
		if (!claimed) throwConflictError(ALREADY_RECORDING);

		let egressId: string;
		try {
			({ egressId } = await startRoomRecording(
				roomNameForSession(session.id),
				key,
			));
		} catch (error) {
			/* @info - Nothing was recorded, so this is not a `failed` recording: the claim is
			 * released and the host may try again. */
			await this.updateRow(session.id, RecordingStatus.RECORDING, {
				recordingStatus: null,
				recordingKey: null,
				recordingStartedAt: null,
			});
			throw error;
		}

		const stored = await this.updateRow(session.id, RecordingStatus.RECORDING, {
			recordingEgressId: egressId,
		});
		this.log.info(
			`live recording ${session.id}: started on ${roomNameForSession(session.id)} as ${egressId}`,
		);
		/* @info - Every `!` in this file is this: the module's error helpers are inferred const
		 * arrows, so TypeScript neither narrows on them nor treats them as unreachable, and a
		 * value the guard above has already rejected still reads as nullable (the moderation
		 * code writes the same `!`). */
		return recordingStateFor(
			(stored ?? (await this.readRow(session.id)) ?? claimed)!,
		);
	};

	/* ── Stop (trigger 1) ────────────────────────────────────────────── */

	/** @info - POST /live/sessions/:sessionId/recording/stop */
	stopRecording = async (
		authData: IAuthData,
		sessionId: number,
	): Promise<LiveSessionRecordingState> => {
		const { session } = await this.sessions.loadForHostAction(
			authData,
			sessionId,
		);
		/* @info - Idempotent for a recording that is already stopping: the host pressing
		 * stop twice is one recording, not an error. */
		if (session.recordingStatus === RecordingStatus.PROCESSING) {
			return recordingStateFor(session);
		}
		if (
			session.recordingStatus !== RecordingStatus.RECORDING ||
			!session.recordingEgressId
		) {
			throwConflictError(NOT_RECORDING);
		}

		await stopRoomRecording(session.recordingEgressId!);
		/* @info - `processing`, not `ready`: the call returning means LiveKit accepted the
		 * stop, not that the file is written (D-P5-14's honest state). */
		const row = await this.updateRow(session.id, RecordingStatus.RECORDING, {
			recordingStatus: RecordingStatus.PROCESSING,
		});
		this.log.info(`live recording ${session.id}: stop requested`);
		return recordingStateFor(row ?? session);
	};

	/**
	 * @info - Trigger 2 (D-P5-15): ending the class ends its recorder - otherwise the
	 * incident D-P5-9 exists to prevent arrives through the front door. Called by end-live,
	 * which must not fail because LiveKit refused a stop: the poll's trigger 4 converges the
	 * row once the room is gone.
	 */
	stopForSessionEnd = async (session: LiveSession): Promise<void> => {
		if (
			session.recordingStatus !== RecordingStatus.RECORDING ||
			!session.recordingEgressId
		) {
			return;
		}
		try {
			await stopRoomRecording(session.recordingEgressId!);
			await this.updateRow(session.id, RecordingStatus.RECORDING, {
				recordingStatus: RecordingStatus.PROCESSING,
			});
			this.log.info(`live recording ${session.id}: stopped with the session`);
		} catch (error) {
			this.log.error(
				`live recording ${session.id}: stopping on end-live failed`,
				error,
			);
		}
	};

	/**
	 * @info - Playback (5b, D-P5-5 as amended): the presigned URL anyone with access watches
	 * the recording through. The URL is minted here and never stored, on every request, after
	 * `resolveAccess` has admitted the caller - which is what makes a dropped enrolment (or a
	 * forwarded link) end access at the next request rather than at the URL's expiry.
	 *
	 * Gate order: the session, then the caller's access, then what state the recording is in
	 * (nothing / failed / not ready / expired), then the download rule, and only then S3. A
	 * refused caller therefore costs no presign at all.
	 */
	recordingUrlFor = async (
		authData: IAuthData,
		sessionId: number,
		disposition: RecordingDisposition = "inline",
	): Promise<{ url: string; expiresIn: number }> => {
		const { session, access } = await this.sessions.loadForPlayback(
			authData,
			sessionId,
		);
		const recording = recordingStateFor(session);

		/* @info - `deleted` answers 404, not "expired": the host destroyed it, and saying
		 * otherwise would advertise that something existed (D-P5-11). */
		if (
			recording.status === null ||
			recording.status === RecordingStatus.DELETED
		) {
			throwNotFoundError(NO_RECORDING);
		}
		/* @info - A failure is the host's to see: the row's own reason, told to them, and
		 * nothing at all to anyone else (D-P5-10). */
		if (recording.status === RecordingStatus.FAILED) {
			if (!access.isHost) throwNotFoundError(NO_RECORDING);
			throwConflictError(recording.error ?? EGRESS_FAILED);
		}
		/* @info - `recording` and `processing` alike: the file is not there yet, and "not
		 * ready" is a state to say rather than an error to bury. */
		if (recording.status !== RecordingStatus.READY) {
			throwConflictError(RECORDING_NOT_READY);
		}
		if (recording.expired) throwGoneError(RECORDING_EXPIRED);
		/* @info - Download belongs to the managing side (D-P5-5 as amended): the host, the
		 * course instructor, a community owner/admin. `isHost` covers the first two for a
		 * lesson session, `canModerate` adds the community's own admins on an event;
		 * `courses.allow_downloads` is deliberately not consulted for recordings. */
		if (
			disposition === "attachment" &&
			!(access.isHost || access.canModerate)
		) {
			throwForbiddenError(DOWNLOAD_IS_MANAGING_SIDE);
		}

		/* @info - The key is written when the row is claimed; the fallback is that same
		 * derived key, never a different path. */
		const key = session.recordingKey ?? recordingKeyFor(session.id);
		const storage = StorageService.getInstance();
		const url = await storage.generatePresignedDownloadUrl(
			disposition === "attachment"
				? {
						key,
						bucket: config.recordings.bucket,
						expiresIn: TTL.IN_AN_HOUR,
						responseContentDisposition: `attachment; filename="${downloadFilenameFor(session)}"`,
					}
				: { key, bucket: config.recordings.bucket, expiresIn: TTL.IN_AN_HOUR },
		);
		return { url, expiresIn: TTL.IN_AN_HOUR };
	};

	/**
	 * @info - DELETE (D-P5-11): the host destroys a recording outright - the case that
	 * matters is the mistake. Host-only rather than moderator-wide: a recording is the one
	 * irreversible thing a live session produces, and a community admin destroying a class
	 * the instructor gave is a policy this feature does not need.
	 *
	 * Idempotent, and refused while a recorder is still running: an in-flight egress writes
	 * its object back after the delete, so "stop it first" is the honest answer - the poll
	 * converges the row within a tick. No UI calls this yet; it closes the "recorded by
	 * mistake" gap as an API capability.
	 */
	deleteRecording = async (
		authData: IAuthData,
		sessionId: number,
	): Promise<{ sessionId: number; deleted: true }> => {
		const { session } = await this.sessions.loadForHostAction(
			authData,
			sessionId,
		);
		const recording = recordingStateFor(session);
		const stored = recording.status;

		/* @info - Already destroyed (or destroyed again): the same answer, and no second
		 * object delete. */
		if (stored === RecordingStatus.DELETED) {
			return { sessionId: session.id, deleted: true };
		}
		if (stored === null) throwNotFoundError(NO_RECORDING);
		if (isRecordingActive(stored)) {
			throwConflictError(STOP_BEFORE_DELETING);
		}

		/* @info - The object goes first: if that fails the row is untouched and the host can
		 * simply try again - which is the one outcome worth refusing, because a `deleted` row
		 * whose file is still in the bucket is exactly what this endpoint exists to prevent. */
		await StorageService.getInstance().delete(
			session.recordingKey ?? recordingKeyFor(session.id),
			config.recordings.bucket,
		);
		const row = await this.updateRow(session.id, stored!, {
			recordingStatus: RecordingStatus.DELETED,
		});
		if (!row) {
			/* @info - The conditional write lost, so the row moved on underneath us (a retry
			 * after a failure is the realistic one). The object is gone; the row reports its
			 * own state. */
			this.log.error(
				`live recording ${session.id}: deleted the object, but the row had already moved`,
			);
		}
		this.log.info(`live recording ${session.id}: deleted`);
		return { sessionId: session.id, deleted: true };
	};

	/* ── The poll (triggers 3 and 4, and the two honest endings) ─────── */

	/**
	 * @info - The poll's job body (D-P5-3). Every row that believes a recorder is running or
	 * finishing, converged against what LiveKit reports: complete -> ready, failed -> the
	 * partial file removed, past the cap -> stopped, gone from LiveKit -> stopped.
	 *
	 * Idempotent by construction: every terminal write is conditional on the status it
	 * expects, so a double fire cannot double-stop, double-delete or double-report, and one
	 * bad row cannot stop the others from converging.
	 *
	 * Soft-deleted sessions are deliberately included - a session deleted mid-recording
	 * still has an egress to stop and a partial file to remove, which is exactly what
	 * trigger 4 is for.
	 */
	pollRecordings = async (): Promise<void> => {
		const db = getDb();
		const rows = await db
			.select()
			.from(liveSessions)
			.where(
				inArray(liveSessions.recordingStatus, [
					RecordingStatus.RECORDING,
					RecordingStatus.PROCESSING,
				]),
			);

		for (const session of rows) {
			try {
				await this.converge(session);
			} catch (error) {
				this.log.error(`live recording ${session.id}: poll failed`, error);
			}
		}
	};

	private converge = async (session: LiveSession): Promise<void> => {
		/* @info - The query above selected exactly these two, and they are the only statuses
		 * that ever hold an egress. */
		const status = session.recordingStatus as RecordingStatus;
		const egressId = session.recordingEgressId;

		if (!egressId) {
			/* @info - Claimed, but LiveKit was never reached (a crash between the two): there
			 * is no egress to stop and no file to keep. Only once the claim is older than any
			 * plausible start call - a younger one is that call, still in flight. */
			const claimedAt = session.recordingStartedAt?.getTime() ?? 0;
			if (Date.now() - claimedAt < START_CLAIM_GRACE_MS) return;
			await this.fail(session, status, RECORDING_LOST);
			return;
		}

		/* @info - Ask LiveKit before deciding anything: its answer says whether there is still
		 * something to stop. This call used to sit BELOW the ended-session branch, so a finished
		 * egress on a finished session was blind-stopped, LiveKit answered 412 ("egress with
		 * status EGRESS_COMPLETE cannot be stopped"), and the row sat at `processing` forever
		 * with its file already written: the first real recording on staging did exactly that,
		 * every 15 seconds, until this was moved. */
		const [info] = await listRoomRecordings(egressId);

		/* @info - Trigger 2 generalised (D-P5-15): a session that is no longer live must not
		 * keep recording. end-live asks for the stop on its own path, but delete and cancel end
		 * a class too, and end-live's stop is best effort - this backstop reaches every route
		 * within one poll tick, instead of the cap's four hours. */
		if (session.deletedAt !== null || session.status !== "live") {
			await this.stopForEndedSession(session, status, egressId, info);
			return;
		}
		if (!info) {
			/* @info - Trigger 4 (D-P5-15): LiveKit no longer knows this egress while we still
			 * believe it is running - the recorder died with its room. A row that was already
			 * stopping has nothing left to stop. This is ours rather than a dependence on
			 * LiveKit's own room-close semantics. */
			if (status === RecordingStatus.RECORDING)
				await this.tryStop(session.id, egressId);
			await this.fail(
				session,
				status,
				status === RecordingStatus.RECORDING ? ROOM_GONE : RECORDING_LOST,
			);
			return;
		}

		switch (info.state) {
			case "complete":
				await this.markReady(session, status, info);
				return;
			case "failed":
			case "aborted":
			case "limit_reached":
				await this.fail(
					session,
					status,
					info.error ?? EGRESS_FAILED,
					info.endedAt,
				);
				return;
			default:
				/* @info - starting / active / ending / unknown: still running as far as this
				 * app is concerned, so the cap applies. */
				await this.enforceStop(session, status, egressId);
		}
	};

	/** @info - The row as it stands. A conditional write that lost is answered with the row's
	 *  real state, never with a snapshot the database has already rejected (review N1). */
	private readRow = async (sessionId: number): Promise<LiveSession | null> => {
		const db = getDb();
		const [row] = await db
			.select()
			.from(liveSessions)
			.where(eq(liveSessions.id, sessionId));
		return row! ?? null;
	};

	/** @info - The session is over, so the recorder goes: claim the row first so two cycles
	 *  cannot both ask, then ask. A row already `processing` is re-asked, which is what
	 *  converges a stop LiveKit refused.
	 *
	 *  The egress's own state is consulted first, because "the session ended" does not mean
	 *  "there is something to stop": a recording that finished on its own, or that the host
	 *  stopped before End session, is already a file. Stopping it again is the 412 above and a
	 *  row stuck at `processing` forever. */
	private stopForEndedSession = async (
		session: LiveSession,
		status: RecordingStatus,
		egressId: string,
		info: EgressInfoSummary | undefined,
	): Promise<void> => {
		if (info?.state === "complete") {
			await this.markReady(session, status, info);
			return;
		}
		if (
			info &&
			(info.state === "failed" ||
				info.state === "aborted" ||
				info.state === "limit_reached")
		) {
			await this.fail(session, status, info.error ?? EGRESS_FAILED, info.endedAt);
			return;
		}
		if (status === RecordingStatus.RECORDING) {
			const claimed = await this.updateRow(session.id, status, {
				recordingStatus: RecordingStatus.PROCESSING,
			});
			if (!claimed) return;
			this.log.info(
				`live recording ${session.id}: session is no longer live, stopping`,
			);
		}
		await this.tryStop(session.id, egressId);
	};

	/** @info - Triggers 3 (the cap) and the convergence of a stop we already asked for. */
	private enforceStop = async (
		session: LiveSession,
		status: RecordingStatus,
		egressId: string,
	): Promise<void> => {
		if (!session.recordingStartedAt) {
			/* @info - No start time means no deadline can be computed, and a recording with no
			 * deadline is the overnight bill. Fail it rather than guess. */
			await this.fail(session, status, RECORDING_LOST);
			return;
		}

		const capMinutes = recordingCapMinutes(session.durationMinutes);
		const deadline = capMinutes * 60_000;
		if (Date.now() - session.recordingStartedAt.getTime() <= deadline) return;

		if (status === RecordingStatus.PROCESSING) {
			/* @info - The stop was already asked for; past the cap it is asked again, which is
			 * what converges a stop that LiveKit refused or a restart lost. Inside the cap a
			 * row in `processing` is simply finishing, and hammering the egress every cycle
			 * would only interfere with finishing the file. */
			await this.tryStop(session.id, egressId);
			return;
		}

		/* @info - Claim the stop first: only the poll cycle that wins the conditional write
		 * calls LiveKit, so two cycles cannot both stop the same egress. */
		const claimed = await this.updateRow(session.id, status, {
			recordingStatus: RecordingStatus.PROCESSING,
		});
		if (!claimed) return;
		this.log.info(
			`live recording ${session.id}: past the ${capMinutes} minute cap, stopping`,
		);
		await this.tryStop(session.id, egressId);
	};

	private markReady = async (
		session: LiveSession,
		expected: RecordingStatus,
		info: EgressInfoSummary,
	): Promise<void> => {
		const claimed = await this.updateRow(session.id, expected, {
			recordingStatus: RecordingStatus.READY,
			recordingDurationSeconds: info.durationSeconds,
			recordingEndedAt: info.endedAt ?? new Date(),
			recordingError: null,
		});
		/* @info - Losing the claim means another cycle already flipped this row: nothing more
		 * to do, which is what keeps the phase 5b fan-out from notifying twice. */
		if (!claimed) return;
		this.log.info(
			`live recording ${session.id}: ready (${info.durationSeconds ?? "unknown"}s)`,
		);
	};

	/** @info - The honest failure (D-P5-10): the row is claimed to `failed` first, so a
	 *  concurrent cycle that just flipped it to `ready` cannot have its file deleted out from
	 *  under it, and then the partial object goes. If that delete fails the row is already
	 *  failed - invisible to students - and the log carries the key. */
	private fail = async (
		session: LiveSession,
		expected: RecordingStatus,
		reason: string,
		endedAt: Date | null = null,
	): Promise<void> => {
		const claimed = await this.updateRow(session.id, expected, {
			recordingStatus: RecordingStatus.FAILED,
			recordingError: reason,
			recordingEndedAt: endedAt ?? new Date(),
		});
		if (!claimed) return;
		this.log.error(`live recording ${session.id}: failed - ${reason}`);
		await this.removeObject(session.id, session.recordingKey);
	};

	/* ── Row writes ──────────────────────────────────────────────────── */

	/** @info - Conditional writes are the whole idempotency of the poll: a row is moved only
	 *  from the status we read, so a second worker converges nothing. */
	private updateRow = async (
		sessionId: number,
		expected: RecordingStatus,
		set: Partial<NewLiveSession>,
	): Promise<LiveSession | null> => {
		const db = getDb();
		const [row] = await db
			.update(liveSessions)
			.set(set)
			.where(
				and(
					eq(liveSessions.id, sessionId),
					eq(liveSessions.recordingStatus, expected),
				),
			)
			.returning();
		return row! ?? null;
	};

	/** @info - Takes the session for one recording. `null` means someone else holds it (or
	 *  has already recorded it) - never a second egress. */
	private claimRow = async (
		sessionId: number,
		key: string,
	): Promise<LiveSession | null> => {
		const db = getDb();
		const [row] = await db
			.update(liveSessions)
			.set({
				recordingStatus: RecordingStatus.RECORDING,
				recordingEgressId: null,
				recordingKey: key,
				recordingDurationSeconds: null,
				recordingStartedAt: new Date(),
				recordingEndedAt: null,
				recordingError: null,
			})
			.where(
				and(
					eq(liveSessions.id, sessionId),
					isNull(liveSessions.deletedAt),
					or(
						isNull(liveSessions.recordingStatus),
						/* @info - A retry after a failure overwrites the failed attempt (D-P5-4). */
						eq(liveSessions.recordingStatus, RecordingStatus.FAILED),
					),
				),
			)
			.returning();
		return row! ?? null;
	};

	private tryStop = async (
		sessionId: number,
		egressId: string,
	): Promise<void> => {
		try {
			await stopRoomRecording(egressId);
		} catch (error) {
			/* @info - Best effort: a refusal usually means the egress already finished or the
			 * room took it with it, and the next poll reads the terminal state. The finished case is
			 * LiveKit's 412, which is the expected answer for a recording that ended before its
			 * session did, so it does not earn a stack trace every 15 seconds. */
			if ((error as { status?: number })?.status === 412) {
				this.log.info(
					`live recording ${sessionId}: ${egressId} had already finished when the stop was asked`,
				);
				return;
			}
			this.log.error(
				`live recording ${sessionId}: stopping ${egressId} failed`,
				error,
			);
		}
	};

	/** @info - The object is removed through the bucket-parameterised storage path (fact 9):
	 *  recordings live in their own bucket, not the media one. */
	private removeObject = async (
		sessionId: number,
		key: string | null,
	): Promise<void> => {
		if (!key) return;
		try {
			await StorageService.getInstance().delete(key, config.recordings.bucket);
		} catch (error) {
			this.log.error(
				`live recording ${sessionId}: removing ${key} failed`,
				error,
			);
		}
	};
}
