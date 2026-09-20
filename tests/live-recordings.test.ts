import { EncodedFileType } from "livekit-server-sdk";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { config } from "@/config";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { JwtAction, RecordingStatus, UserTypes } from "@/enums";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import {
	LiveRecordingService,
	recordingCapMinutes,
	recordingKeyFor,
	recordingStateFor,
	roomNameForSession,
} from "@/modules/live";
import { liveRouter } from "@/modules/live/live.routes";
import { LiveService } from "@/modules/live/live.service";
import type { EgressInfoSummary } from "@/modules/live/live-egress.client";
import * as egressClient from "@/modules/live/live-egress.client";
import { recordingFileOutput } from "@/modules/live/live-egress.client";
import { LiveSessionService } from "@/modules/live/live-session.service";
import { StorageService } from "@/services";

/**
 * @info - Live sessions phase 5: capture (5a) and playback/access/delete (5b), spec
 * section 7 and brief-backend-phase5b.md.
 *
 * LiveKit's egress API is mocked through `@/modules/live/live-egress.client`, exactly as
 * the moderation tests mock the room client: these tests are about our own gate order, the
 * one-recording-per-session rule and the four stop triggers. Egress is genuinely enabled on
 * the shared LiveKit project, so a test that reached the real service would start a real
 * recording - every leg here runs against the mock, and the S3 delete is mocked too so no
 * test can write to the recordings bucket.
 *
 * What matters here, in order of consequence:
 *
 *  - gate order (D-P5-1): host, then native, then live, and only then LiveKit. A
 *    non-host must not be able to cause a single egress call.
 *  - one recording per session: a second start is a 409 with no LiveKit call, so a
 *    double-click cannot orphan a running egress.
 *  - the cap has a floor (D-P5-9): a `durationMinutes` of 0 is capped at 120 minutes.
 *  - the poll is the only thing that flips a row, and it is idempotent.
 *
 * Phase 5b adds the other half: who may be handed a presigned URL for what is already in
 * the bucket, what the session payload says about it (a state, never a link), and the
 * host's delete. The 1-hour TTL is the URL's, not the link's (spec section 15): the frontend
 * builds the stable Hive link itself, so nothing here mints or stores one.
 *
 * Creates real rows in a throwaway community/course and cleans them up.
 */
describe("Live sessions phase 5 (recording capture, playback and deletion)", () => {
	const live = LiveService.getInstance();
	const sessions = LiveSessionService.getInstance();
	const recordings = LiveRecordingService.getInstance();
	let db: ReturnType<typeof getDb>;

	const stamp = Date.now();

	let hostUserId: number;
	let adminUserId: number;
	let memberUserId: number;
	let enrolledUserId: number;
	let outsiderUserId: number;
	let communityId: number;
	let courseId: number;
	let moduleId: number;
	let lessonSessionId: number;
	let externalSessionId: number;
	let scheduledSessionId: number;

	const auth = (id: number): IAuthData => ({
		id,
		authId: String(id),
		action: JwtAction.AUTHENTICATE,
		userType: UserTypes.USER,
		firstName: "Live",
		lastName: "Phase Five",
	});

	/** @info - A URL that looks signed and reaches nothing: the presign itself is mocked, so
	 *  no test can mint a real one for the recordings bucket. */
	const PRESIGNED_URL =
		"https://hive-recordings.s3.amazonaws.com/session/recording.mp4?signed=test";

	const startSpy = () => vi.mocked(egressClient.startRoomRecording);
	const stopSpy = () => vi.mocked(egressClient.stopRoomRecording);
	const listSpy = () => vi.mocked(egressClient.listRoomRecordings);
	const presignSpy = () =>
		vi.mocked(StorageService.getInstance().generatePresignedDownloadUrl);
	const deleteSpy = () => vi.mocked(StorageService.getInstance().delete);

	/** @info - Capture the thrown error as the client would see it (status + message). */
	const capture = async (fn: () => Promise<unknown>) => {
		try {
			await fn();
			return null;
		} catch (error) {
			const thrown = error as { message: string; status: number };
			return { message: thrown.message, status: thrown.status };
		}
	};

	const row = async (sessionId: number) =>
		(await db.execute(`SELECT * FROM live_sessions WHERE id = ${sessionId}`))
			.rows[0] as {
			recording_status: string | null;
			recording_egress_id: string | null;
			recording_key: string | null;
			recording_duration_seconds: number | null;
			/* @info - raw pg returns timestamptz as a string, unlike drizzle's select() */
			recording_started_at: string | null;
			recording_ended_at: string | null;
			recording_error: string | null;
			updated_at: string;
			status: string;
		};

	/** @info - Put a row mid-recording, as the start endpoint would have left it. */
	const stampRecording = async (
		sessionId: number,
		status: RecordingStatus,
		options: {
			egressId?: string;
			startedAgoMinutes?: number;
			durationSeconds?: number;
			error?: string;
		} = {},
	) => {
		const egressId = options.egressId ?? `EG_${sessionId}_${stamp}`;
		const startedAt =
			options.startedAgoMinutes === undefined
				? "now()"
				: `now() - interval '${options.startedAgoMinutes} minutes'`;
		await db.execute(
			`UPDATE live_sessions SET recording_status='${status}',
				recording_egress_id='${egressId}',
				recording_key='${recordingKeyFor(sessionId)}',
				recording_started_at=${startedAt},
				recording_ended_at=CASE WHEN '${status}' = '${RecordingStatus.RECORDING}' THEN NULL ELSE now() END,
				recording_duration_seconds=${options.durationSeconds ?? "NULL"},
				recording_error=${options.error ? `'${options.error}'` : "NULL"}
			 WHERE id = ${sessionId}`,
		);
		return egressId;
	};

	/** @info - A finished class: the state a recording is watched in (5b). */
	const endSession = async (sessionId: number) => {
		await db.execute(
			`UPDATE live_sessions SET status='ended' WHERE id = ${sessionId}`,
		);
	};

	/** @info - The claim a start writes BEFORE its LiveKit call returns: `recording`, and no
	 *  egress id yet. This is the state the poll used to orphan (review finding B1). */
	const stampClaim = async (sessionId: number, startedAgoMinutes = 0) => {
		await db.execute(
			`UPDATE live_sessions SET recording_status='${RecordingStatus.RECORDING}',
				recording_egress_id=NULL,
				recording_key='${recordingKeyFor(sessionId)}',
				recording_started_at=now() - interval '${startedAgoMinutes} minutes',
				recording_ended_at=NULL,
				recording_duration_seconds=NULL,
				recording_error=NULL
			 WHERE id = ${sessionId}`,
		);
	};

	/** @info - An egress as `listEgress` reports one, mapped by our own client module. */
	const egressInfo = (
		egressId: string,
		state: EgressInfoSummary["state"],
		options: { durationSeconds?: number; error?: string } = {},
	): EgressInfoSummary => ({
		egressId,
		roomName: roomNameForSession(lessonSessionId),
		state,
		startedAt: new Date(Date.now() - 10 * 60_000),
		endedAt: state === "complete" ? new Date() : null,
		durationSeconds: options.durationSeconds ?? null,
		error: options.error ?? null,
	});

	beforeAll(async () => {
		await connectPostgresDB(() => {});
		db = getDb();

		const makeUser = async (email: string) => {
			const r = await db.execute(
				`INSERT INTO users (first_name, last_name, email, email_verified, onboarded)
				 VALUES ('Live', 'Test', '${email}', true, true) RETURNING id`,
			);
			return (r.rows[0] as { id: number }).id;
		};

		hostUserId = await makeUser(`rec-host-${stamp}@test.local`);
		adminUserId = await makeUser(`rec-admin-${stamp}@test.local`);
		memberUserId = await makeUser(`rec-member-${stamp}@test.local`);
		enrolledUserId = await makeUser(`rec-enrolled-${stamp}@test.local`);
		outsiderUserId = await makeUser(`rec-outsider-${stamp}@test.local`);

		const communityRows = await db.execute(
			`INSERT INTO communities (owner_id, name, slug)
			 VALUES (${hostUserId}, 'Recording Community', 'recording-${stamp}')
			 RETURNING id`,
		);
		communityId = (communityRows.rows[0] as { id: number }).id;

		const courseRows = await db.execute(
			`INSERT INTO courses (instructor_id, community_id, title, slug, status, category, price)
			 VALUES (${hostUserId}, ${communityId}, 'Recording Course', 'recording-course-${stamp}', 'published', 'test', 0)
			 RETURNING id`,
		);
		courseId = (courseRows.rows[0] as { id: number }).id;

		const moduleRows = await db.execute(
			`INSERT INTO modules (course_id, title, sort_order)
			 VALUES (${courseId}, 'Recording Module', 999) RETURNING id`,
		);
		moduleId = (moduleRows.rows[0] as { id: number }).id;

		await db.execute(
			`INSERT INTO enrollments (user_id, course_id) VALUES (${enrolledUserId}, ${courseId})`,
		);
		/* @info - the admin is a community owner/admin but NOT the course instructor: a
		 * lesson session's recording stays host-only (no widening, decision A). */
		await db.execute(
			`INSERT INTO community_members (community_id, user_id, role, member_role, status)
			 VALUES (${communityId}, ${adminUserId}, 'student', 'admin', 'active'),
			        (${communityId}, ${memberUserId}, 'student', 'member', 'active')`,
		);

		const makeSession = async (
			title: string,
			kind: string,
			courseIdValue: number | null,
			status: string,
			durationMinutes: number,
		) => {
			const r = await db.execute(
				`INSERT INTO live_sessions (kind, community_id, course_id, host_id, title, starts_at, duration_minutes, status)
				 VALUES ('${kind}', ${communityId}, ${courseIdValue ?? "NULL"}, ${hostUserId}, '${title}', now() + interval '1 day', ${durationMinutes}, '${status}')
				 RETURNING id`,
			);
			return (r.rows[0] as { id: number }).id;
		};

		lessonSessionId = await makeSession(
			"Recording Lesson",
			"native",
			courseId,
			"live",
			60,
		);
		externalSessionId = await makeSession(
			"Recording External",
			"external",
			null,
			"live",
			60,
		);
		scheduledSessionId = await makeSession(
			"Recording Scheduled",
			"native",
			null,
			"scheduled",
			60,
		);

		await db.execute(
			`INSERT INTO lessons (module_id, title, type, status, sort_order, live_session_id)
			 VALUES (${moduleId}, 'Recording Lesson', 'live', 'published', 0, ${lessonSessionId})`,
		);
	});

	afterAll(async () => {
		await db.execute(
			`DELETE FROM lessons WHERE live_session_id = ${lessonSessionId}`,
		);
		await db.execute(
			`DELETE FROM live_sessions WHERE id IN (${lessonSessionId}, ${externalSessionId}, ${scheduledSessionId})`,
		);
		await db.execute(`DELETE FROM enrollments WHERE course_id = ${courseId}`);
		await db.execute(`DELETE FROM modules WHERE id = ${moduleId}`);
		await db.execute(`DELETE FROM courses WHERE id = ${courseId}`);
		await db.execute(
			`DELETE FROM community_members WHERE community_id = ${communityId}`,
		);
		await db.execute(`DELETE FROM communities WHERE id = ${communityId}`);
		await db.execute(
			`DELETE FROM users WHERE id IN (${hostUserId}, ${adminUserId}, ${memberUserId}, ${enrolledUserId}, ${outsiderUserId})`,
		);
	});

	beforeEach(async () => {
		/* @info - `vi.spyOn` returns the same spy on a second call, so its call history has to
		 * be cleared or every "never called" assertion would read the previous test. */
		vi.clearAllMocks();
		vi.spyOn(egressClient, "startRoomRecording").mockResolvedValue({
			egressId: `EG_started_${Date.now()}`,
		});
		vi.spyOn(egressClient, "stopRoomRecording").mockResolvedValue(undefined);
		vi.spyOn(egressClient, "listRoomRecordings").mockResolvedValue([]);
		/* @info - mocked so a broken poll cannot delete a real object in the recordings bucket */
		vi.spyOn(StorageService.getInstance(), "delete").mockResolvedValue(
			{} as never,
		);
		/* @info - mocked so no test can mint a real presigned URL against the recordings
		 *  bucket, and so "never presigned" is an assertion rather than a reading of the code */
		vi.spyOn(
			StorageService.getInstance(),
			"generatePresignedDownloadUrl",
		).mockResolvedValue(PRESIGNED_URL);

		/* @info - each test starts from live, never-recorded sessions */
		await db.execute(
			`UPDATE live_sessions SET status='live', deleted_at=NULL, duration_minutes=60,
				recording_status=NULL, recording_egress_id=NULL, recording_key=NULL,
				recording_duration_seconds=NULL, recording_started_at=NULL,
				recording_ended_at=NULL, recording_error=NULL
			 WHERE id IN (${lessonSessionId}, ${externalSessionId}, ${scheduledSessionId})`,
		);
		await db.execute(
			`UPDATE live_sessions SET status='scheduled' WHERE id = ${scheduledSessionId}`,
		);
	});

	/* ── Start: the gate order, then one egress per session ──────────── */

	it("lets the host start: the derived room name, our own key, and the row reads recording", async () => {
		const state = await recordings.startRecording(
			auth(hostUserId),
			lessonSessionId,
		);

		expect(startSpy()).toHaveBeenCalledTimes(1);
		expect(startSpy()).toHaveBeenCalledWith(
			roomNameForSession(lessonSessionId),
			recordingKeyFor(lessonSessionId),
		);
		/* @info - the key is environment-prefixed (D-P5-7), so a dev run cannot write a prod key */
		const [, filepath] = startSpy().mock.calls[0]!;
		expect(filepath.startsWith(`${config.recordings.keyPrefix}/`)).toBe(true);
		expect(filepath).toBe(
			`${config.recordings.keyPrefix}/session-${lessonSessionId}/recording.mp4`,
		);

		const stored = await row(lessonSessionId);
		expect(stored.recording_status).toBe(RecordingStatus.RECORDING);
		expect(stored.recording_egress_id).toBeTruthy();
		expect(stored.recording_key).toBe(recordingKeyFor(lessonSessionId));
		expect(stored.recording_started_at).toBeTruthy();
		expect(state.status).toBe(RecordingStatus.RECORDING);
		expect(state.startedAt).toBeInstanceOf(Date);
		expect(state.expired).toBe(false);
	});

	it("sends exactly one MP4 into the private recordings bucket", () => {
		const output = recordingFileOutput(recordingKeyFor(lessonSessionId));

		expect(output.fileType).toBe(EncodedFileType.MP4);
		expect(output.filepath).toBe(recordingKeyFor(lessonSessionId));
		expect(output.output.case).toBe("s3");
		if (output.output.case !== "s3") throw new Error("expected an S3 output");
		expect(output.output.value.bucket).toBe(config.recordings.bucket);
		expect(output.output.value.region).toBe(config.aws.region);
		expect(output.output.value.accessKey).toBe(config.aws.accessKeyId);
	});

	it("refuses an enrolled student with 403 and never calls LiveKit", async () => {
		const result = await capture(() =>
			recordings.startRecording(auth(enrolledUserId), lessonSessionId),
		);

		expect(result).not.toBeNull();
		expect(result!.status).toBe(403);
		expect(startSpy()).not.toHaveBeenCalled();
		expect((await row(lessonSessionId)).recording_status).toBeNull();
	});

	it("refuses a community owner/admin on a lesson session (no widening) and never calls LiveKit", async () => {
		const result = await capture(() =>
			recordings.startRecording(auth(adminUserId), lessonSessionId),
		);

		expect(result!.status).toBe(403);
		expect(startSpy()).not.toHaveBeenCalled();
	});

	it("refuses an external session and never calls LiveKit", async () => {
		const result = await capture(() =>
			recordings.startRecording(auth(hostUserId), externalSessionId),
		);

		expect(result!.status).toBe(400);
		expect(startSpy()).not.toHaveBeenCalled();
	});

	it("refuses a session that is not live and never calls LiveKit", async () => {
		const result = await capture(() =>
			recordings.startRecording(auth(hostUserId), scheduledSessionId),
		);

		expect(result!.status).toBe(400);
		expect(startSpy()).not.toHaveBeenCalled();
	});

	it("409s a second start while one is active, keeping the one egress id and making no second call", async () => {
		await recordings.startRecording(auth(hostUserId), lessonSessionId);
		const stored = await row(lessonSessionId);

		const second = await capture(() =>
			recordings.startRecording(auth(hostUserId), lessonSessionId),
		);
		expect(second!.status).toBe(409);
		expect(startSpy()).toHaveBeenCalledTimes(1);
		expect((await row(lessonSessionId)).recording_egress_id).toBe(
			stored.recording_egress_id,
		);

		/* a recording that is stopping is still one recording */
		await stampRecording(lessonSessionId, RecordingStatus.PROCESSING);
		const whileProcessing = await capture(() =>
			recordings.startRecording(auth(hostUserId), lessonSessionId),
		);
		expect(whileProcessing!.status).toBe(409);
		expect(startSpy()).toHaveBeenCalledTimes(1);

		/* a finished recording is not replaced by pressing record again */
		await db.execute(
			`UPDATE live_sessions SET recording_status='${RecordingStatus.READY}' WHERE id = ${lessonSessionId}`,
		);
		const whileReady = await capture(() =>
			recordings.startRecording(auth(hostUserId), lessonSessionId),
		);
		expect(whileReady!.status).toBe(409);
		expect(startSpy()).toHaveBeenCalledTimes(1);
	});

	it("releases the claim when LiveKit refuses to start, so the failure is not a stuck row", async () => {
		startSpy().mockRejectedValue(new Error("egress disabled"));

		await expect(
			recordings.startRecording(auth(hostUserId), lessonSessionId),
		).rejects.toThrow(/egress disabled/);

		expect((await row(lessonSessionId)).recording_status).toBeNull();
	});

	it("a retry after a failure overwrites the failed attempt", async () => {
		await db.execute(
			`UPDATE live_sessions SET recording_status='${RecordingStatus.FAILED}',
				recording_error='egress died', recording_key='${recordingKeyFor(lessonSessionId)}'
			 WHERE id = ${lessonSessionId}`,
		);

		const state = await recordings.startRecording(
			auth(hostUserId),
			lessonSessionId,
		);

		expect(state.status).toBe(RecordingStatus.RECORDING);
		const stored = await row(lessonSessionId);
		expect(stored.recording_error).toBeNull();
		expect(stored.recording_egress_id).toBeTruthy();
	});

	/* ── Stop (trigger 1) and end-live (trigger 2) ───────────────────── */

	it("stops with the stored egress id and moves the row to processing", async () => {
		const egressId = await stampRecording(
			lessonSessionId,
			RecordingStatus.RECORDING,
		);

		const state = await recordings.stopRecording(
			auth(hostUserId),
			lessonSessionId,
		);

		expect(stopSpy()).toHaveBeenCalledTimes(1);
		expect(stopSpy()).toHaveBeenCalledWith(egressId);
		expect(state.status).toBe(RecordingStatus.PROCESSING);
		expect((await row(lessonSessionId)).recording_status).toBe(
			RecordingStatus.PROCESSING,
		);
	});

	it("refuses a stop from a non-host, and a stop when nothing is recording", async () => {
		await stampRecording(lessonSessionId, RecordingStatus.RECORDING);

		const notHost = await capture(() =>
			recordings.stopRecording(auth(enrolledUserId), lessonSessionId),
		);
		expect(notHost!.status).toBe(403);
		expect(stopSpy()).not.toHaveBeenCalled();

		await db.execute(
			`UPDATE live_sessions SET recording_status=NULL WHERE id = ${lessonSessionId}`,
		);
		const nothing = await capture(() =>
			recordings.stopRecording(auth(hostUserId), lessonSessionId),
		);
		expect(nothing!.status).toBe(409);
		expect(stopSpy()).not.toHaveBeenCalled();
	});

	it("end-live stops an active recorder (trigger 2)", async () => {
		const egressId = await stampRecording(
			lessonSessionId,
			RecordingStatus.RECORDING,
		);

		await live.endLive(auth(hostUserId), lessonSessionId);

		expect(stopSpy()).toHaveBeenCalledWith(egressId);
		const stored = await row(lessonSessionId);
		expect(stored.status).toBe("ended");
		expect(stored.recording_status).toBe(RecordingStatus.PROCESSING);
	});

	it("end-live leaves a session that was never recorded exactly as it was", async () => {
		await live.endLive(auth(hostUserId), lessonSessionId);

		expect(stopSpy()).not.toHaveBeenCalled();
		expect((await row(lessonSessionId)).recording_status).toBeNull();
	});

	/* ── The poll (triggers 3 and 4, and the two honest failures) ────── */

	it("poll on EGRESS_COMPLETE: ready with the duration, and a second poll changes nothing", async () => {
		const egressId = await stampRecording(
			lessonSessionId,
			RecordingStatus.RECORDING,
		);
		listSpy().mockResolvedValue([
			egressInfo(egressId, "complete", { durationSeconds: 631 }),
		]);

		await recordings.pollRecordings();

		const stored = await row(lessonSessionId);
		expect(stored.recording_status).toBe(RecordingStatus.READY);
		expect(stored.recording_duration_seconds).toBe(631);
		expect(stored.recording_ended_at).toBeTruthy();

		/* idempotent: the row has left the recording/processing set, so a second fire does
		 * not even ask LiveKit again - nothing can be double-notified (notifications land
		 * in 5b, but the state machine's part is this guard) */
		const callsAfterFirst = listSpy().mock.calls.length;
		const stamped = (await row(lessonSessionId)).updated_at;
		await recordings.pollRecordings();

		expect(listSpy().mock.calls.length).toBe(callsAfterFirst);
		expect((await row(lessonSessionId)).updated_at).toEqual(stamped);
		expect(deleteSpy()).not.toHaveBeenCalled();
		expect(stopSpy()).not.toHaveBeenCalled();
	});

	it("does not fail a claim whose LiveKit start is still in flight (B1)", async () => {
		await stampClaim(lessonSessionId);

		await recordings.pollRecordings();

		/* The egress this row is about to own belongs to THIS row and to nobody else. Failing
		 * it here is what orphaned a running recorder: the id was then stored nowhere, the cap
		 * could not reach it, and the host's own stop answered 409. */
		const stored = await row(lessonSessionId);
		expect(stored.recording_status).toBe(RecordingStatus.RECORDING);
		expect(stored.recording_error).toBeNull();
		expect(deleteSpy()).not.toHaveBeenCalled();
		expect(stopSpy()).not.toHaveBeenCalled();
		/* LiveKit is not even asked: a start in flight has nothing to report yet. */
		expect(listSpy()).not.toHaveBeenCalled();
	});

	it("still converges a claim abandoned between the write and the LiveKit call", async () => {
		await stampClaim(lessonSessionId, 2);

		await recordings.pollRecordings();

		const stored = await row(lessonSessionId);
		expect(stored.recording_status).toBe(RecordingStatus.FAILED);
		expect(stored.recording_error).toBeTruthy();
		expect(deleteSpy()).toHaveBeenCalledWith(
			recordingKeyFor(lessonSessionId),
			config.recordings.bucket,
		);
	});

	it("stops a recording whose session was deleted, without waiting for the cap", async () => {
		/* Delete and cancel end a class as surely as end-live does (D-P5-15's rationale), and
		 * the cap is up to four hours away - which is the incident, not a delay. */
		const egressId = await stampRecording(
			lessonSessionId,
			RecordingStatus.RECORDING,
		);
		listSpy().mockResolvedValue([egressInfo(egressId, "active")]);
		await db.execute(
			`UPDATE live_sessions SET deleted_at = now() WHERE id = ${lessonSessionId}`,
		);

		await recordings.pollRecordings();

		expect(stopSpy()).toHaveBeenCalledWith(egressId);
		expect((await row(lessonSessionId)).recording_status).toBe(
			RecordingStatus.PROCESSING,
		);
		expect(deleteSpy()).not.toHaveBeenCalled();
	});

	it("stops a recording whose session was cancelled, without waiting for the cap", async () => {
		const egressId = await stampRecording(
			lessonSessionId,
			RecordingStatus.RECORDING,
		);
		listSpy().mockResolvedValue([egressInfo(egressId, "active")]);
		await db.execute(
			`UPDATE live_sessions SET status='cancelled' WHERE id = ${lessonSessionId}`,
		);

		await recordings.pollRecordings();

		expect(stopSpy()).toHaveBeenCalledWith(egressId);
		expect((await row(lessonSessionId)).recording_status).toBe(
			RecordingStatus.PROCESSING,
		);
	});

	it("poll on a failed egress: the partial object is deleted and the row says why", async () => {
		const egressId = await stampRecording(
			lessonSessionId,
			RecordingStatus.RECORDING,
		);
		listSpy().mockResolvedValue([
			egressInfo(egressId, "failed", { error: "egress crashed" }),
		]);

		await recordings.pollRecordings();

		expect(deleteSpy()).toHaveBeenCalledWith(
			recordingKeyFor(lessonSessionId),
			config.recordings.bucket,
		);
		const stored = await row(lessonSessionId);
		expect(stored.recording_status).toBe(RecordingStatus.FAILED);
		expect(stored.recording_error).toContain("egress crashed");
		expect(stored.recording_ended_at).toBeTruthy();
	});

	it("poll on an aborted egress takes the same honest path", async () => {
		const egressId = await stampRecording(
			lessonSessionId,
			RecordingStatus.RECORDING,
		);
		listSpy().mockResolvedValue([egressInfo(egressId, "aborted")]);

		await recordings.pollRecordings();

		expect(deleteSpy()).toHaveBeenCalledTimes(1);
		const stored = await row(lessonSessionId);
		expect(stored.recording_status).toBe(RecordingStatus.FAILED);
		expect(stored.recording_error).toBeTruthy();
	});

	it("poll past the cap stops the egress (trigger 3), with 60 minutes of floor", async () => {
		const egressId = await stampRecording(
			lessonSessionId,
			RecordingStatus.RECORDING,
			{ startedAgoMinutes: 121 },
		);
		listSpy().mockResolvedValue([egressInfo(egressId, "active")]);

		await recordings.pollRecordings();

		expect(stopSpy()).toHaveBeenCalledWith(egressId);
		expect((await row(lessonSessionId)).recording_status).toBe(
			RecordingStatus.PROCESSING,
		);
	});

	it("caps a session whose durationMinutes is 0 at 120 minutes, not 60", async () => {
		expect(recordingCapMinutes(0)).toBe(120);
		expect(recordingCapMinutes(60)).toBe(120);
		expect(recordingCapMinutes(180)).toBe(240);

		const egressId = await stampRecording(
			lessonSessionId,
			RecordingStatus.RECORDING,
			{ startedAgoMinutes: 90 },
		);
		await db.execute(
			`UPDATE live_sessions SET duration_minutes = 0 WHERE id = ${lessonSessionId}`,
		);
		listSpy().mockResolvedValue([egressInfo(egressId, "active")]);

		await recordings.pollRecordings();
		expect(stopSpy()).not.toHaveBeenCalled();
		expect((await row(lessonSessionId)).recording_status).toBe(
			RecordingStatus.RECORDING,
		);

		await db.execute(
			`UPDATE live_sessions SET recording_started_at = now() - interval '121 minutes' WHERE id = ${lessonSessionId}`,
		);
		await recordings.pollRecordings();

		expect(stopSpy()).toHaveBeenCalledWith(egressId);
	});

	it("does not re-ask for a stop inside the cap: a row in processing is simply finishing", async () => {
		const egressId = await stampRecording(
			lessonSessionId,
			RecordingStatus.PROCESSING,
			{ startedAgoMinutes: 20 },
		);
		listSpy().mockResolvedValue([egressInfo(egressId, "active")]);

		await recordings.pollRecordings();

		expect(stopSpy()).not.toHaveBeenCalled();
		expect((await row(lessonSessionId)).recording_status).toBe(
			RecordingStatus.PROCESSING,
		);
	});

	it("re-asks past the cap for a row still in processing, so a refused stop converges (risk 3)", async () => {
		const egressId = await stampRecording(
			lessonSessionId,
			RecordingStatus.PROCESSING,
			{ startedAgoMinutes: 121 },
		);
		listSpy().mockResolvedValue([egressInfo(egressId, "active")]);

		await recordings.pollRecordings();

		expect(stopSpy()).toHaveBeenCalledWith(egressId);
		expect((await row(lessonSessionId)).recording_status).toBe(
			RecordingStatus.PROCESSING,
		);
	});

	it("poll when LiveKit no longer knows the egress stops it (trigger 4)", async () => {
		const egressId = await stampRecording(
			lessonSessionId,
			RecordingStatus.RECORDING,
		);
		listSpy().mockResolvedValue([]);

		await recordings.pollRecordings();

		expect(stopSpy()).toHaveBeenCalledWith(egressId);
		expect(deleteSpy()).toHaveBeenCalledWith(
			recordingKeyFor(lessonSessionId),
			config.recordings.bucket,
		);
		const stored = await row(lessonSessionId);
		expect(stored.recording_status).toBe(RecordingStatus.FAILED);
		expect(stored.recording_error).toBeTruthy();
	});

	it("poll past the cap does not stop a recording that completed: completion wins", async () => {
		const egressId = await stampRecording(
			lessonSessionId,
			RecordingStatus.PROCESSING,
			{ startedAgoMinutes: 200 },
		);
		listSpy().mockResolvedValue([
			egressInfo(egressId, "complete", { durationSeconds: 12_000 }),
		]);

		await recordings.pollRecordings();

		expect(stopSpy()).not.toHaveBeenCalled();
		expect((await row(lessonSessionId)).recording_status).toBe(
			RecordingStatus.READY,
		);
	});

	/* ── Phase 5b: playback - one access-checked URL, re-checked every request ── */

	it("refuses a URL to an outsider and to a member who is not enrolled, minting nothing", async () => {
		await stampRecording(lessonSessionId, RecordingStatus.READY, {
			durationSeconds: 631,
		});

		const outsider = await capture(() =>
			recordings.recordingUrlFor(auth(outsiderUserId), lessonSessionId),
		);
		expect(outsider!.status).toBe(403);

		/* a community member is not an enrolled student: a lesson session's recording stays
		 * behind enrollment (decision A, no widening) */
		const member = await capture(() =>
			recordings.recordingUrlFor(auth(memberUserId), lessonSessionId),
		);
		expect(member!.status).toBe(403);

		expect(presignSpy()).not.toHaveBeenCalled();
	});

	it("gives an enrolled student a presigned URL from the recordings bucket, good for an hour", async () => {
		await stampRecording(lessonSessionId, RecordingStatus.READY, {
			durationSeconds: 631,
		});
		await endSession(lessonSessionId);

		const result = await recordings.recordingUrlFor(
			auth(enrolledUserId),
			lessonSessionId,
		);

		expect(result).toEqual({ url: PRESIGNED_URL, expiresIn: 3600 });
		expect(presignSpy()).toHaveBeenCalledTimes(1);
		/* @info - inline is the default, so nothing overrides the response headers: a stream,
		 * not a download */
		expect(presignSpy()).toHaveBeenCalledWith({
			key: recordingKeyFor(lessonSessionId),
			bucket: config.recordings.bucket,
			expiresIn: 3600,
		});
	});

	it("refuses a student's attachment, minting nothing further", async () => {
		await stampRecording(lessonSessionId, RecordingStatus.READY, {
			durationSeconds: 631,
		});

		const result = await capture(() =>
			recordings.recordingUrlFor(
				auth(enrolledUserId),
				lessonSessionId,
				"attachment",
			),
		);

		expect(result!.status).toBe(403);
		expect(presignSpy()).not.toHaveBeenCalled();
	});

	it("lets the managing side download: the course instructor, and a community owner/admin on an event", async () => {
		await stampRecording(lessonSessionId, RecordingStatus.READY, {
			durationSeconds: 631,
		});

		const instructor = await recordings.recordingUrlFor(
			auth(hostUserId),
			lessonSessionId,
			"attachment",
		);
		expect(instructor.url).toBe(PRESIGNED_URL);
		expect(presignSpy()).toHaveBeenLastCalledWith({
			key: recordingKeyFor(lessonSessionId),
			bucket: config.recordings.bucket,
			expiresIn: 3600,
			responseContentDisposition: 'attachment; filename="Recording-Lesson.mp4"',
		});

		/* a standalone event is not a course: its recording's managing side is the host or a
		 * community owner/admin (D-P5-5 as amended) */
		await endSession(scheduledSessionId);
		await stampRecording(scheduledSessionId, RecordingStatus.READY, {
			durationSeconds: 100,
		});
		const admin = await recordings.recordingUrlFor(
			auth(adminUserId),
			scheduledSessionId,
			"attachment",
		);
		expect(admin.expiresIn).toBe(3600);
		expect(presignSpy()).toHaveBeenLastCalledWith(
			expect.objectContaining({
				key: recordingKeyFor(scheduledSessionId),
				bucket: config.recordings.bucket,
				responseContentDisposition:
					'attachment; filename="Recording-Scheduled.mp4"',
			}),
		);
	});

	it("404s a session that was never recorded, for the host and for a student alike", async () => {
		const host = await capture(() =>
			recordings.recordingUrlFor(auth(hostUserId), lessonSessionId),
		);
		expect(host!.status).toBe(404);

		const student = await capture(() =>
			recordings.recordingUrlFor(auth(enrolledUserId), lessonSessionId),
		);
		expect(student!.status).toBe(404);

		expect(presignSpy()).not.toHaveBeenCalled();
	});

	it("409s a recording that is still processing: not ready is a state, not a missing file", async () => {
		await stampRecording(lessonSessionId, RecordingStatus.PROCESSING);

		const host = await capture(() =>
			recordings.recordingUrlFor(auth(hostUserId), lessonSessionId),
		);
		expect(host!.status).toBe(409);
		expect(host!.message).toMatch(/not ready|still being (written|processed)/i);

		const student = await capture(() =>
			recordings.recordingUrlFor(auth(enrolledUserId), lessonSessionId),
		);
		expect(student!.status).toBe(409);

		expect(presignSpy()).not.toHaveBeenCalled();
	});

	it("tells the host why a recording failed, and shows a student nothing at all (D-P5-10)", async () => {
		await stampRecording(lessonSessionId, RecordingStatus.FAILED, {
			error: "The recording failed before it could be saved.",
		});

		const host = await capture(() =>
			recordings.recordingUrlFor(auth(hostUserId), lessonSessionId),
		);
		expect(host!.status).toBe(409);
		expect(host!.message).toContain(
			"The recording failed before it could be saved.",
		);

		/* a student is told nothing exists: a half-recording is worse than an honest silence */
		const student = await capture(() =>
			recordings.recordingUrlFor(auth(enrolledUserId), lessonSessionId),
		);
		expect(student!.status).toBe(404);

		expect(presignSpy()).not.toHaveBeenCalled();
	});

	it("404s a deleted recording for everyone, the host included - deleted is not expired", async () => {
		await stampRecording(lessonSessionId, RecordingStatus.DELETED);

		const host = await capture(() =>
			recordings.recordingUrlFor(auth(hostUserId), lessonSessionId),
		);
		expect(host!.status).toBe(404);

		const student = await capture(() =>
			recordings.recordingUrlFor(auth(enrolledUserId), lessonSessionId),
		);
		expect(student!.status).toBe(404);

		expect(presignSpy()).not.toHaveBeenCalled();
	});

	it("refuses an expired recording with 410 - after the payload has already said so", async () => {
		await stampRecording(lessonSessionId, RecordingStatus.READY, {
			startedAgoMinutes: 91 * 24 * 60,
			durationSeconds: 3600,
		});
		await endSession(lessonSessionId);

		const view = await live.getSession(auth(enrolledUserId), lessonSessionId);
		expect(view.recording).toEqual({
			status: RecordingStatus.READY,
			durationSeconds: 3600,
			expired: true,
		});

		const student = await capture(() =>
			recordings.recordingUrlFor(auth(enrolledUserId), lessonSessionId),
		);
		expect(student!.status).toBe(410);

		/* the managing side gets the same answer: the object is not there for anyone, and a
		 * download of nothing is not a download */
		const host = await capture(() =>
			recordings.recordingUrlFor(
				auth(hostUserId),
				lessonSessionId,
				"attachment",
			),
		);
		expect(host!.status).toBe(410);

		expect(presignSpy()).not.toHaveBeenCalled();
	});

	it("carries the state and never a URL: the summary has three keys and nothing URL-shaped", async () => {
		await stampRecording(lessonSessionId, RecordingStatus.READY, {
			durationSeconds: 631,
		});

		const view = await live.getSession(auth(enrolledUserId), lessonSessionId);

		expect(view.recording).toEqual({
			status: RecordingStatus.READY,
			durationSeconds: 631,
			expired: false,
		});
		expect(Object.keys(view.recording ?? {}).sort()).toEqual([
			"durationSeconds",
			"expired",
			"status",
		]);
		/* @info - the summary is serialised on its own: `meetingUrl` is the payload's one
		 * pre-existing URL-named key (null on a native session), so asserting over the whole
		 * payload would be an assertion about a key that has nothing to do with recordings. */
		const summary = JSON.stringify(view.recording);
		expect(summary).not.toMatch(/http/i);
		expect(summary).not.toMatch(/url/i);
		/* the payload as a whole carries no URL: this is a session, not a link */
		expect(JSON.stringify(view)).not.toMatch(/http/i);
	});

	it("shows a student that a recording is ready, and never that one failed", async () => {
		await stampRecording(lessonSessionId, RecordingStatus.READY, {
			durationSeconds: 631,
		});
		await endSession(lessonSessionId);

		const ready = await live.getSession(auth(enrolledUserId), lessonSessionId);
		expect(ready.recording?.status).toBe(RecordingStatus.READY);

		await stampRecording(lessonSessionId, RecordingStatus.FAILED, {
			error: "egress crashed",
		});
		const student = await live.getSession(
			auth(enrolledUserId),
			lessonSessionId,
		);
		/* the key is there and reads null - the shape a consumer can rely on, rather than an
		 * absent field it would have to guess about */
		expect(student).toHaveProperty("recording", null);

		const host = await live.getSession(auth(hostUserId), lessonSessionId);
		expect(host.recording).toEqual({
			status: RecordingStatus.FAILED,
			durationSeconds: null,
			expired: false,
		});
	});

	it("carries the same summary in the community's past-sessions list, with the managing side flagged", async () => {
		await endSession(scheduledSessionId);
		await stampRecording(scheduledSessionId, RecordingStatus.READY, {
			durationSeconds: 100,
		});

		const past = await live.listCommunitySessions(
			auth(adminUserId),
			communityId,
			"past",
		);
		const listed = past.find((entry) => entry.id === scheduledSessionId);

		expect(listed?.recording).toEqual({
			status: RecordingStatus.READY,
			durationSeconds: 100,
			expired: false,
		});
		/* @info - this list is the managing side's surface (D-P5-6 as amended): the
		 * owner/admin's `canModerate` is what the frontend's Download hangs on, and an ordinary
		 * member sees the same state without it */
		expect(listed?.canModerate).toBe(true);

		const asMember = await live.listCommunitySessions(
			auth(memberUserId),
			communityId,
			"past",
		);
		const memberView = asMember.find(
			(entry) => entry.id === scheduledSessionId,
		);
		expect(memberView?.recording?.status).toBe(RecordingStatus.READY);
		expect(memberView?.canModerate).toBe(false);
	});

	/* ── Phase 5b: the host's delete (D-P5-11) ──────────────────────── */

	it("deletes only for the host, idempotently, and takes the recording out of every surface", async () => {
		await stampRecording(lessonSessionId, RecordingStatus.READY, {
			durationSeconds: 631,
		});

		/* not the host: the enrolled student, and a community owner/admin (a paid course's
		 * class stays host-only, and destroying a recording is the host's own call) */
		const student = await capture(() =>
			recordings.deleteRecording(auth(enrolledUserId), lessonSessionId),
		);
		expect(student!.status).toBe(403);
		const admin = await capture(() =>
			recordings.deleteRecording(auth(adminUserId), lessonSessionId),
		);
		expect(admin!.status).toBe(403);
		expect(deleteSpy()).not.toHaveBeenCalled();

		const deleted = await recordings.deleteRecording(
			auth(hostUserId),
			lessonSessionId,
		);
		expect(deleted).toEqual({ sessionId: lessonSessionId, deleted: true });
		expect(deleteSpy()).toHaveBeenCalledTimes(1);
		expect(deleteSpy()).toHaveBeenCalledWith(
			recordingKeyFor(lessonSessionId),
			config.recordings.bucket,
		);
		expect((await row(lessonSessionId)).recording_status).toBe(
			RecordingStatus.DELETED,
		);

		/* twice is one delete, and the answer is the same: the host pressing it again after a
		 * slow response is not an error */
		const again = await recordings.deleteRecording(
			auth(hostUserId),
			lessonSessionId,
		);
		expect(again).toEqual({ sessionId: lessonSessionId, deleted: true });
		expect(deleteSpy()).toHaveBeenCalledTimes(1);

		/* gone from every surface - and 404, not "expired": nothing existed as far as the
		 * people who paid are concerned (D-P5-11) */
		expect(
			(await live.getSession(auth(hostUserId), lessonSessionId)).recording,
		).toBeNull();
		expect(
			(await live.getSession(auth(enrolledUserId), lessonSessionId)).recording,
		).toBeNull();
		const url = await capture(() =>
			recordings.recordingUrlFor(auth(enrolledUserId), lessonSessionId),
		);
		expect(url!.status).toBe(404);
		expect(presignSpy()).not.toHaveBeenCalled();

		/* deleting nothing is a 404, not a delete call: there is no object to remove */
		const nothing = await capture(() =>
			recordings.deleteRecording(auth(hostUserId), scheduledSessionId),
		);
		expect(nothing!.status).toBe(404);
		expect(deleteSpy()).toHaveBeenCalledTimes(1);
	});

	it("refuses a delete while a recorder is still running, rather than orphaning its file", async () => {
		await stampRecording(lessonSessionId, RecordingStatus.RECORDING);

		const result = await capture(() =>
			recordings.deleteRecording(auth(hostUserId), lessonSessionId),
		);

		/* a partial object is written back after the delete, so the honest answer is "stop it
		 * first": the poll converges it to ready (or failed) within one tick */
		expect(result!.status).toBe(409);
		expect(result!.message).toMatch(/stop the recording/i);
		expect(deleteSpy()).not.toHaveBeenCalled();
		expect((await row(lessonSessionId)).recording_status).toBe(
			RecordingStatus.RECORDING,
		);
	});

	it("refuses a delete on an external session, which has no recording to destroy", async () => {
		const external = await capture(() =>
			recordings.deleteRecording(auth(hostUserId), externalSessionId),
		);
		expect(external!.status).toBe(400);
		expect(deleteSpy()).not.toHaveBeenCalled();
	});

	it("signs the recordings bucket and the attachment filename into the real URL", async () => {
		/* @info - the only leg that calls the real presign: signing is local (no request is
		 * made), and it is what proves the bucket and the disposition reach the signature
		 * rather than the spy's argument list. */
		presignSpy().mockRestore();

		const url = await StorageService.getInstance().generatePresignedDownloadUrl(
			{
				key: recordingKeyFor(lessonSessionId),
				bucket: config.recordings.bucket,
				responseContentDisposition: 'attachment; filename="x.mp4"',
			},
		);
		const decoded = decodeURIComponent(url);

		expect(decoded).toContain(config.recordings.bucket);
		expect(decoded).toContain(
			'response-content-disposition=attachment; filename="x.mp4"',
		);
	});

	/* ── Derived state (spec section 4) and the untouched surfaces ───── */

	it("derives expiry instead of storing it, and keeps deleted distinct from never recorded", async () => {
		const never = await sessions.loadById(lessonSessionId);
		expect(recordingStateFor(never)).toMatchObject({
			status: null,
			expired: false,
		});

		await db.execute(
			`UPDATE live_sessions SET recording_status='${RecordingStatus.READY}',
				recording_started_at = now() - interval '91 days'
			 WHERE id = ${lessonSessionId}`,
		);
		const expired = recordingStateFor(await sessions.loadById(lessonSessionId));
		expect(expired.status).toBe(RecordingStatus.READY);
		expect(expired.expired).toBe(true);

		await db.execute(
			`UPDATE live_sessions SET recording_started_at = now() - interval '89 days' WHERE id = ${lessonSessionId}`,
		);
		expect(
			recordingStateFor(await sessions.loadById(lessonSessionId)).expired,
		).toBe(false);

		await db.execute(
			`UPDATE live_sessions SET recording_status='${RecordingStatus.DELETED}' WHERE id = ${lessonSessionId}`,
		);
		expect(
			recordingStateFor(await sessions.loadById(lessonSessionId)).status,
		).toBe(RecordingStatus.DELETED);
	});

	it("leaves a session that was never recorded behaving exactly as before, bar one null field", async () => {
		const view = await live.getSession(auth(hostUserId), lessonSessionId);

		/* @info - exactly today's keys plus `recording`: the payload gained one nullable field
		 * and every existing consumer keeps working (brief non-negotiable 9, leg 13) */
		expect(Object.keys(view).sort()).toEqual(
			[
				"canJoin",
				"canModerate",
				"communityId",
				"communitySlug",
				"courseId",
				"description",
				"durationMinutes",
				"hostId",
				"id",
				"isHost",
				"kind",
				"lesson",
				"meetingUrl",
				"recording",
				"startsAt",
				"status",
				"title",
			].sort(),
		);
		expect(view).toMatchObject({
			id: lessonSessionId,
			kind: "native",
			status: "live",
			isHost: true,
			lesson: { title: "Recording Lesson" },
			recording: null,
		});

		const token = await live.issueToken(auth(enrolledUserId), lessonSessionId);
		expect(token.roomName).toBe(roomNameForSession(lessonSessionId));

		const outsider = await capture(() =>
			live.getSession(auth(outsiderUserId), lessonSessionId),
		);
		expect(outsider!.status).toBe(403);
	});
});

/**
 * @info - The legs above call the service directly, so a typo in a path string would ship
 * green. `/live` is mounted in src/routes/router.ts, so these are the router-relative paths.
 */
describe("Live sessions phase 5a (route wiring)", () => {
	it("mounts the recording start and stop paths", () => {
		const table = liveRouter.routes.map(
			(route) => `${route.method} ${route.path}`,
		);

		expect(table).toContain("POST /sessions/:sessionId/recording/start");
		expect(table).toContain("POST /sessions/:sessionId/recording/stop");
	});

	it("mounts the phase 5b playback and delete paths", () => {
		const table = liveRouter.routes.map(
			(route) => `${route.method} ${route.path}`,
		);

		/* @info - GET with a query flag, not POST: minting a URL changes nothing server-side */
		expect(table).toContain("GET /sessions/:sessionId/recording/url");
		expect(table).toContain("DELETE /sessions/:sessionId/recording");
	});

	it("keeps the phase 1/2/3 paths intact", () => {
		const table = liveRouter.routes.map(
			(route) => `${route.method} ${route.path}`,
		);

		expect(table).toContain("POST /sessions/:sessionId/token");
		expect(table).toContain("POST /sessions/:sessionId/go-live");
		expect(table).toContain("POST /sessions/:sessionId/end-live");
		expect(table).toContain(
			"POST /sessions/:sessionId/participants/:identity/mute",
		);
	});
});
