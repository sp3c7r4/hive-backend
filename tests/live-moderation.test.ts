import { decode } from "jsonwebtoken";
import { TrackSource, TrackType } from "livekit-server-sdk";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { JwtAction, UserTypes } from "@/enums";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
/**
 * @info - Live sessions phase 3: in-room control (spec section 10, checks 1-12).
 *
 * LiveKit's server API is mocked: these tests are about our own gate order, our
 * deny-list and the calls we make. A real HTTP call would be testing LiveKit.
 *
 * What matters here, in order of consequence:
 *
 *  - gate order (D-P3-18): authorization strictly precedes target validation, so a
 *    non-moderator gets a byte-identical 403 for a real identity and a made-up one,
 *    and we never call LiveKit on their behalf
 *  - the deny-list is the door: removing someone refuses their *next* token
 *  - a mistaken removal is recoverable without ending the class (D-P3-17)
 *  - moderation is a wider power than membership: host-only on a lesson session
 *    (D-P3-15)
 *
 * Creates real rows in a throwaway community/course and cleans them up.
 */
import {
	LiveService,
	LiveSessionService,
	roomNameForSession,
} from "@/modules/live";
import * as roomClient from "@/modules/live/live-room.client";
import { liveRouter } from "@/modules/live/live.routes";
import { CacheService } from "@/services";

/**
 * @info - LiveKit's server API stands in as a spy rather than `vi.mock`: tests/setup.ts
 * imports the whole route tree, so this module is already loaded and cached by the time
 * a test file's `vi.mock` would run (the repo's other mocking tests work around that with
 * `vi.resetModules()` + dynamic import). `getRoomServiceClient` is called lazily inside
 * each moderation method, so replacing the export intercepts every call.
 */
const roomService = {
	listParticipants: vi.fn(),
	mutePublishedTrack: vi.fn(),
	updateParticipant: vi.fn(),
	removeParticipant: vi.fn(),
};

describe("Live sessions phase 3 (in-room moderation)", () => {
	const live = LiveService.getInstance();
	const sessions = LiveSessionService.getInstance();
	const redis = CacheService.getInstance().getRedisClient();
	let db: ReturnType<typeof getDb>;

	const stamp = Date.now();

	let hostUserId: number;
	let adminUserId: number;
	let memberUserId: number;
	let memberTwoUserId: number;
	let enrolledUserId: number;
	let outsiderUserId: number;
	let communityId: number;
	let courseId: number;
	let moduleId: number;
	let lessonSessionId: number;
	let standaloneSessionId: number;
	let scheduledSessionId: number;

	const auth = (id: number): IAuthData => ({
		id,
		authId: String(id),
		action: JwtAction.AUTHENTICATE,
		userType: UserTypes.USER,
		firstName: "Live",
		lastName: "Phase Three",
	});

	const identityOf = (id: number) => `user-${id}`;
	const denyKey = (sessionId: number) =>
		`live:deny:${roomNameForSession(sessionId)}`;
	const room = (sessionId: number) => roomNameForSession(sessionId);

	/** @info - A live participant as LiveKit's API reports one. */
	const participant = (
		id: number,
		options: { mic?: boolean; name?: string } = {},
	) => ({
		identity: identityOf(id),
		name: options.name ?? `Participant ${id}`,
		tracks:
			options.mic === false
				? []
				: [
						{
							sid: `TR_mic_${id}`,
							type: TrackType.AUDIO,
							source: TrackSource.MICROPHONE,
							muted: false,
						},
					],
	});

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

	const removeMember = (sessionId: number, targetId: number, byId: number) =>
		live.removeParticipant(auth(byId), sessionId, identityOf(targetId));

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

		hostUserId = await makeUser(`mod-host-${stamp}@test.local`);
		adminUserId = await makeUser(`mod-admin-${stamp}@test.local`);
		memberUserId = await makeUser(`mod-member-${stamp}@test.local`);
		memberTwoUserId = await makeUser(`mod-member2-${stamp}@test.local`);
		enrolledUserId = await makeUser(`mod-enrolled-${stamp}@test.local`);
		outsiderUserId = await makeUser(`mod-outsider-${stamp}@test.local`);

		const communityRows = await db.execute(
			`INSERT INTO communities (owner_id, name, slug)
			 VALUES (${hostUserId}, 'Moderation Community', 'moderation-${stamp}')
			 RETURNING id`,
		);
		communityId = (communityRows.rows[0] as { id: number }).id;

		const courseRows = await db.execute(
			`INSERT INTO courses (instructor_id, community_id, title, slug, status, category, price)
			 VALUES (${hostUserId}, ${communityId}, 'Moderation Course', 'moderation-course-${stamp}', 'published', 'test', 0)
			 RETURNING id`,
		);
		courseId = (courseRows.rows[0] as { id: number }).id;

		const modRows = await db.execute(
			`INSERT INTO modules (course_id, title, sort_order)
			 VALUES (${courseId}, 'Moderation Module', 999) RETURNING id`,
		);
		moduleId = (modRows.rows[0] as { id: number }).id;

		/* @info - the enrolled student is deliberately NOT a community member: a lesson
		 * session must not widen to community membership, and vice versa. */
		await db.execute(
			`INSERT INTO enrollments (user_id, course_id) VALUES (${enrolledUserId}, ${courseId})`,
		);
		await db.execute(
			`INSERT INTO community_members (community_id, user_id, role, member_role, status)
			 VALUES (${communityId}, ${adminUserId}, 'student', 'admin', 'active'),
			        (${communityId}, ${memberUserId}, 'student', 'member', 'active'),
			        (${communityId}, ${memberTwoUserId}, 'student', 'member', 'active')`,
		);

		const makeSession = async (
			title: string,
			courseIdValue: number | null,
			status: string,
		) => {
			const r = await db.execute(
				`INSERT INTO live_sessions (kind, community_id, course_id, host_id, title, starts_at, duration_minutes, status)
				 VALUES ('native', ${communityId}, ${courseIdValue ?? "NULL"}, ${hostUserId}, '${title}', now() + interval '1 day', 60, '${status}')
				 RETURNING id`,
			);
			return (r.rows[0] as { id: number }).id;
		};

		lessonSessionId = await makeSession("Moderation Lesson", courseId, "live");
		standaloneSessionId = await makeSession("Moderation Event", null, "live");
		scheduledSessionId = await makeSession(
			"Moderation Scheduled",
			null,
			"scheduled",
		);

		await db.execute(
			`INSERT INTO lessons (module_id, title, type, status, sort_order, live_session_id)
			 VALUES (${moduleId}, 'Moderation Lesson', 'live', 'published', 0, ${lessonSessionId})`,
		);
	});

	afterAll(async () => {
		await db.execute(
			`DELETE FROM lessons WHERE live_session_id = ${lessonSessionId}`,
		);
		await db.execute(
			`DELETE FROM live_sessions WHERE id IN (${lessonSessionId}, ${standaloneSessionId}, ${scheduledSessionId})`,
		);
		await db.execute(`DELETE FROM enrollments WHERE course_id = ${courseId}`);
		await db.execute(`DELETE FROM modules WHERE id = ${moduleId}`);
		await db.execute(`DELETE FROM courses WHERE id = ${courseId}`);
		await db.execute(
			`DELETE FROM community_members WHERE community_id = ${communityId}`,
		);
		await db.execute(`DELETE FROM communities WHERE id = ${communityId}`);
		await db.execute(
			`DELETE FROM users WHERE id IN (${hostUserId}, ${adminUserId}, ${memberUserId}, ${memberTwoUserId}, ${enrolledUserId}, ${outsiderUserId})`,
		);
	});

	beforeEach(async () => {
		for (const fn of Object.values(roomService)) fn.mockReset();
		vi.spyOn(roomClient, "getRoomServiceClient").mockReturnValue(
			roomService as never,
		);
		/* @info - each test starts from a live, undeleted pair of sessions with a clean
		 * room: status changes and removals must not leak across tests. */
		await db.execute(
			`UPDATE live_sessions SET status = 'live', deleted_at = NULL
			 WHERE id IN (${lessonSessionId}, ${standaloneSessionId}, ${scheduledSessionId})`,
		);
		await db.execute(
			`UPDATE live_sessions SET status = 'scheduled' WHERE id = ${scheduledSessionId}`,
		);
		await redis.del(
			denyKey(lessonSessionId),
			denyKey(standaloneSessionId),
			denyKey(scheduledSessionId),
		);
		const limits = await redis.keys("ratelimit:livetoken:*");
		if (limits.length) await redis.del(...limits);
	});

	/* ── Gate order: authorization before target validation (D-P3-18) ─── */

	it("gives a non-moderator a byte-identical 403 for a real and a bogus identity, and never calls LiveKit", async () => {
		const real = identityOf(enrolledUserId);
		const bogus = "user-99999999";

		const results = [
			await capture(() =>
				live.muteParticipant(auth(memberUserId), lessonSessionId, real, true),
			),
			await capture(() =>
				live.muteParticipant(auth(memberUserId), lessonSessionId, bogus, true),
			),
			await capture(() =>
				live.removeParticipant(auth(memberUserId), lessonSessionId, real),
			),
			await capture(() =>
				live.removeParticipant(auth(memberUserId), lessonSessionId, bogus),
			),
			await capture(() =>
				live.readmitParticipant(auth(memberUserId), lessonSessionId, real),
			),
			await capture(() =>
				live.readmitParticipant(auth(memberUserId), lessonSessionId, bogus),
			),
			await capture(() =>
				live.listRemovedParticipants(auth(memberUserId), lessonSessionId),
			),
		];

		expect(results[0]).not.toBeNull();
		expect(results[0]!.status).toBe(403);
		/* identical across real/bogus and across endpoints: no oracle, no hints */
		for (const result of results) {
			expect(result).toEqual(results[0]);
		}

		expect(roomService.listParticipants).not.toHaveBeenCalled();
		expect(roomService.mutePublishedTrack).not.toHaveBeenCalled();
		expect(roomService.updateParticipant).not.toHaveBeenCalled();
		expect(roomService.removeParticipant).not.toHaveBeenCalled();
	});

	it("refuses an outsider exactly like a member, and 404s an unknown session", async () => {
		const memberDenied = await capture(() =>
			live.removeParticipant(
				auth(memberUserId),
				lessonSessionId,
				identityOf(enrolledUserId),
			),
		);
		const outsiderDenied = await capture(() =>
			live.removeParticipant(
				auth(outsiderUserId),
				lessonSessionId,
				identityOf(enrolledUserId),
			),
		);
		expect(outsiderDenied).toEqual(memberDenied);
		expect(outsiderDenied!.status).toBe(403);

		const missing = await capture(() =>
			live.removeParticipant(
				auth(hostUserId),
				987654321,
				identityOf(memberUserId),
			),
		);
		expect(missing!.status).toBe(404);
		expect(missing!.message).toMatch(/session not found/i);

		await db.execute(
			`UPDATE live_sessions SET deleted_at = now() WHERE id = ${standaloneSessionId}`,
		);
		const deleted = await capture(() =>
			live.removeParticipant(
				auth(hostUserId),
				standaloneSessionId,
				identityOf(memberUserId),
			),
		);
		expect(deleted!.status).toBe(404);
	});

	it("refuses the host and the caller as targets, before touching LiveKit", async () => {
		const hostTarget = await capture(() =>
			live.muteParticipant(
				auth(hostUserId),
				standaloneSessionId,
				identityOf(hostUserId),
				true,
			),
		);
		expect(hostTarget!.status).toBe(400);

		const removeHost = await capture(() =>
			live.removeParticipant(
				auth(adminUserId),
				standaloneSessionId,
				identityOf(hostUserId),
			),
		);
		expect(removeHost!.status).toBe(400);

		/* the caller may not moderate themselves either (a community admin here) */
		const self = await capture(() =>
			live.removeParticipant(
				auth(adminUserId),
				standaloneSessionId,
				identityOf(adminUserId),
			),
		);
		expect(self!.status).toBe(400);

		expect(roomService.listParticipants).not.toHaveBeenCalled();
		expect(roomService.removeParticipant).not.toHaveBeenCalled();
	});

	it("refuses moderation on a session that is not live", async () => {
		const result = await capture(() =>
			live.muteParticipant(
				auth(hostUserId),
				scheduledSessionId,
				identityOf(memberUserId),
				true,
			),
		);
		expect(result!.status).toBe(400);
		expect(result!.message).toMatch(/not live|has not started/i);

		const remove = await capture(() =>
			live.removeParticipant(
				auth(hostUserId),
				scheduledSessionId,
				identityOf(memberUserId),
			),
		);
		expect(remove!.status).toBe(400);

		expect(roomService.listParticipants).not.toHaveBeenCalled();
	});

	it("409s a mute when the participant has no published microphone", async () => {
		roomService.listParticipants.mockResolvedValue([
			participant(memberUserId, { mic: false }),
		]);

		const result = await capture(() =>
			live.muteParticipant(
				auth(adminUserId),
				standaloneSessionId,
				identityOf(memberUserId),
				true,
			),
		);
		expect(result!.status).toBe(409);
		expect(result!.message).toMatch(/microphone/i);
		expect(roomService.mutePublishedTrack).not.toHaveBeenCalled();

		/* the same identity, present but with no microphone, is not a 404: the
		 * distinction is what lets the UI offer "ask them" instead of "they left" */
		const missing = await capture(() =>
			live.muteParticipant(
				auth(adminUserId),
				standaloneSessionId,
				"user-99999999",
				true,
			),
		);
		expect(missing!.status).toBe(404);
	});

	it("mutes and unmutes a participant server-side, and lets a non-host owner/admin do it", async () => {
		roomService.listParticipants.mockResolvedValue([participant(memberUserId)]);
		roomService.mutePublishedTrack.mockResolvedValue({ sid: "TR_mic" });

		const muted = await live.muteParticipant(
			auth(adminUserId),
			standaloneSessionId,
			identityOf(memberUserId),
			true,
		);
		expect(muted).toEqual({ identity: identityOf(memberUserId), muted: true });
		expect(roomService.mutePublishedTrack).toHaveBeenCalledWith(
			room(standaloneSessionId),
			identityOf(memberUserId),
			`TR_mic_${memberUserId}`,
			true,
		);

		/* fact 8: the same call unmutes - the host is not limited to one direction */
		const unmuted = await live.muteParticipant(
			auth(adminUserId),
			standaloneSessionId,
			identityOf(memberUserId),
			false,
		);
		expect(unmuted).toEqual({
			identity: identityOf(memberUserId),
			muted: false,
		});
		expect(roomService.mutePublishedTrack).toHaveBeenLastCalledWith(
			room(standaloneSessionId),
			identityOf(memberUserId),
			`TR_mic_${memberUserId}`,
			false,
		);
	});

	/* ── Removal and the deny-list ───────────────────────────────────── */

	it("removes a participant: revoke, then eject, then deny their next token", async () => {
		roomService.listParticipants.mockResolvedValue([
			participant(memberUserId, { name: "Amaka" }),
		]);
		roomService.updateParticipant.mockResolvedValue(participant(memberUserId));
		roomService.removeParticipant.mockResolvedValue(undefined);

		const result = await live.removeParticipant(
			auth(adminUserId),
			standaloneSessionId,
			identityOf(memberUserId),
		);
		expect(result).toEqual({ identity: identityOf(memberUserId) });

		/* permissions are revoked first, so the moment before ejection is harmless */
		expect(roomService.updateParticipant).toHaveBeenCalledWith(
			room(standaloneSessionId),
			identityOf(memberUserId),
			{
				permission: {
					canPublish: false,
					canSubscribe: false,
					canPublishData: false,
				},
			},
		);
		const updateOrder =
			roomService.updateParticipant.mock.invocationCallOrder[0]!;
		const removeOrder =
			roomService.removeParticipant.mock.invocationCallOrder[0]!;
		expect(updateOrder).toBeLessThan(removeOrder);
		expect(roomService.removeParticipant).toHaveBeenCalledWith(
			room(standaloneSessionId),
			identityOf(memberUserId),
		);

		/* the deny-list: room-name keyed (so staging and production cannot collide on
		 * shared Redis), readable value, and a TTL */
		const key = denyKey(standaloneSessionId);
		const entries = await redis.hgetall(key);
		expect(Object.keys(entries)).toEqual([identityOf(memberUserId)]);
		expect(JSON.parse(entries[identityOf(memberUserId)]!)).toMatchObject({
			name: "Amaka",
		});
		expect(await redis.ttl(key)).toBeGreaterThan(0);

		/* the door, not just the room */
		const denied = await capture(() =>
			live.issueToken(auth(memberUserId), standaloneSessionId),
		);
		expect(denied!.status).toBe(403);
		expect(denied!.message).toMatch(/removed from this session/i);

		/* someone who already left the room is still denied: that is the point of
		 * keeping the list rather than trusting the room */
		roomService.listParticipants.mockResolvedValue([]);
		const gone = await live.removeParticipant(
			auth(adminUserId),
			standaloneSessionId,
			identityOf(memberTwoUserId),
		);
		expect(gone).toEqual({ identity: identityOf(memberTwoUserId) });
		expect(Object.keys(await redis.hgetall(key))).toHaveLength(2);
	});

	it("lets a removed participant back in without ending the class, and only that one", async () => {
		roomService.listParticipants.mockResolvedValue([
			participant(memberUserId, { name: "Amaka" }),
			participant(memberTwoUserId, { name: "Bola" }),
		]);
		roomService.updateParticipant.mockResolvedValue({});
		roomService.removeParticipant.mockResolvedValue(undefined);

		await removeMember(standaloneSessionId, memberUserId, adminUserId);
		await removeMember(standaloneSessionId, memberTwoUserId, adminUserId);

		const key = denyKey(standaloneSessionId);
		expect(Object.keys(await redis.hgetall(key)).sort()).toEqual(
			[identityOf(memberUserId), identityOf(memberTwoUserId)].sort(),
		);

		const readmitted = await live.readmitParticipant(
			auth(adminUserId),
			standaloneSessionId,
			identityOf(memberUserId),
		);
		expect(readmitted).toEqual({ identity: identityOf(memberUserId) });

		/* exactly one entry dropped, the other survives */
		expect(Object.keys(await redis.hgetall(key))).toEqual([
			identityOf(memberTwoUserId),
		]);

		/* their token works again, and the class never ended */
		const token = await live.issueToken(
			auth(memberUserId),
			standaloneSessionId,
		);
		expect(token.token).toBeTruthy();
		expect((await sessions.loadById(standaloneSessionId)).status).toBe("live");

		/* idempotent: letting back in someone who was never removed is not an error */
		await expect(
			live.readmitParticipant(
				auth(adminUserId),
				standaloneSessionId,
				identityOf(memberUserId),
			),
		).resolves.toEqual({ identity: identityOf(memberUserId) });
	});

	it("clears the deny-list when the host ends the session", async () => {
		roomService.listParticipants.mockResolvedValue([participant(memberUserId)]);
		roomService.updateParticipant.mockResolvedValue({});
		roomService.removeParticipant.mockResolvedValue(undefined);

		await removeMember(standaloneSessionId, memberUserId, hostUserId);
		const key = denyKey(standaloneSessionId);
		expect(await redis.hlen(key)).toBe(1);

		await live.endLive(auth(hostUserId), standaloneSessionId);

		expect(await redis.exists(key)).toBe(0);

		/* a restarted class is fresh. Asserting the token directly after end-live would
		 * prove nothing - the session has ended, so nobody may join it. The host going
		 * live again is the real scenario, and the removed participant may now return. */
		await live.goLive(auth(hostUserId), standaloneSessionId);
		const token = await live.issueToken(
			auth(memberUserId),
			standaloneSessionId,
		);
		expect(token.token).toBeTruthy();
	});

	it("lists who is removed for a moderator only, and reflects both directions", async () => {
		roomService.listParticipants.mockResolvedValue([
			participant(memberUserId, { name: "Amaka" }),
		]);
		roomService.updateParticipant.mockResolvedValue({});
		roomService.removeParticipant.mockResolvedValue(undefined);

		await removeMember(standaloneSessionId, memberUserId, hostUserId);

		const list = await live.listRemovedParticipants(
			auth(hostUserId),
			standaloneSessionId,
		);
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({
			identity: identityOf(memberUserId),
			name: "Amaka",
		});
		expect(Number.isNaN(Date.parse(String(list[0]!.removedAt)))).toBe(false);

		/* a non-moderator cannot read the list, and the refusal carries no names */
		const denied = await capture(() =>
			live.listRemovedParticipants(auth(memberTwoUserId), standaloneSessionId),
		);
		expect(denied!.status).toBe(403);
		expect(denied!.message).not.toMatch(/amaka/i);

		await live.readmitParticipant(
			auth(hostUserId),
			standaloneSessionId,
			identityOf(memberUserId),
		);
		expect(
			await live.listRemovedParticipants(auth(hostUserId), standaloneSessionId),
		).toEqual([]);
	});

	/* ── Claims and access matrix ────────────────────────────────────── */

	it("puts the role and the self-update grant on the token without changing the rest", async () => {
		const host = await live.issueToken(auth(hostUserId), standaloneSessionId);
		const hostPayload = decode(host.token) as {
			attributes?: Record<string, string>;
			name?: string;
			video?: Record<string, unknown>;
		};
		expect(hostPayload.attributes).toMatchObject({ role: "host" });
		expect(hostPayload.video!.canUpdateOwnMetadata).toBe(true);
		expect(hostPayload.video!.roomAdmin).toBe(true);
		expect(hostPayload.video!.canPublish).toBe(true);
		expect(hostPayload.video!.canSubscribe).toBe(true);
		expect(hostPayload.video!.canPublishData).toBe(true);
		expect(hostPayload.name).toBe("Live Phase Three");

		const member = await live.issueToken(
			auth(memberUserId),
			standaloneSessionId,
		);
		const memberPayload = decode(member.token) as {
			attributes?: Record<string, string>;
			video?: Record<string, unknown>;
		};
		expect(memberPayload.attributes).toMatchObject({ role: "member" });
		expect(memberPayload.video!.roomAdmin).toBeFalsy();
		expect(memberPayload.video!.canUpdateOwnMetadata).toBe(true);

		/* the course instructor is the host of a lesson session even when another
		 * user's id is on the row - the role label follows the same rule as roomAdmin */
		await db.execute(
			`UPDATE live_sessions SET host_id = ${outsiderUserId} WHERE id = ${lessonSessionId}`,
		);
		const instructor = await live.issueToken(auth(hostUserId), lessonSessionId);
		expect(
			(decode(instructor.token) as { attributes?: Record<string, string> })
				.attributes,
		).toMatchObject({ role: "host" });
	});

	it("keeps moderation host-only on a lesson session (no widening)", async () => {
		roomService.listParticipants.mockResolvedValue([
			participant(enrolledUserId),
		]);
		roomService.mutePublishedTrack.mockResolvedValue({ sid: "TR_mic" });

		/* the community admin moderates a standalone event... */
		const standalone = await live.getSession(
			auth(adminUserId),
			standaloneSessionId,
		);
		expect(standalone.canModerate).toBe(true);

		/* ...but not a paid course's live class, which they are not enrolled in. The view
		 * itself is closed to them (canJoin gates it), so the flag is read off the access
		 * resolution - which is the same call the moderation gate makes. */
		const lessonSession = await sessions.loadById(lessonSessionId);
		const lessonAccess = await sessions.resolveAccess(
			lessonSession,
			auth(adminUserId),
		);
		expect(lessonAccess.canModerate).toBe(false);
		expect(lessonAccess.canJoin).toBe(false);

		const denied = await capture(() =>
			live.muteParticipant(
				auth(adminUserId),
				lessonSessionId,
				identityOf(enrolledUserId),
				true,
			),
		);
		expect(denied!.status).toBe(403);
		expect(roomService.mutePublishedTrack).not.toHaveBeenCalled();

		/* the enrolled student cannot moderate either */
		const student = await capture(() =>
			live.removeParticipant(
				auth(enrolledUserId),
				lessonSessionId,
				identityOf(enrolledUserId),
			),
		);
		expect(student!.status).toBe(403);
	});

	/* ── Regression: phase 1/2 surfaces are unchanged ────────────────── */

	it("leaves the session view and the phase 1/2 rules as they were", async () => {
		const view = await live.getSession(auth(hostUserId), lessonSessionId);
		expect(view).toMatchObject({
			id: lessonSessionId,
			kind: "native",
			status: "live",
			isHost: true,
			canModerate: true,
			canJoin: true,
			lesson: { title: "Moderation Lesson" },
		});
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
				"startsAt",
				"status",
				"title",
			].sort(),
		);

		/* the kind stays immutable on edit (phase 2 rule) */
		const kindChange = await capture(() =>
			live.updateSession(auth(hostUserId), standaloneSessionId, {
				kind: "external",
				meetingUrl: "https://meet.example/x",
			}),
		);
		expect(kindChange!.status).toBe(400);
		expect(kindChange!.message).toMatch(/cannot be changed/i);

		/* go-live is still host-only */
		const notHost = await capture(() =>
			live.goLive(auth(memberUserId), standaloneSessionId),
		);
		expect(notHost!.status).toBe(403);
	});
});

/**
 * @info - The tests above call LiveService directly, so a typo in a path string would
 * ship green (tests/setup.ts importing the route tree only proves it loads). This asserts
 * the table itself. The `/live` prefix is mounted in src/routes/router.ts, so these are
 * the router-relative paths exactly as the spec lists them.
 */
describe("Live sessions phase 3 (route wiring)", () => {
	it("mounts the four moderation paths the frontend calls, with the right methods", () => {
		const table = liveRouter.routes.map(
			(route) => `${route.method} ${route.path}`,
		);

		expect(table).toContain(
			"POST /sessions/:sessionId/participants/:identity/mute",
		);
		expect(table).toContain(
			"POST /sessions/:sessionId/participants/:identity/remove",
		);
		expect(table).toContain(
			"POST /sessions/:sessionId/participants/:identity/readmit",
		);
		expect(table).toContain("GET /sessions/:sessionId/participants/removed");
	});

	it("keeps the phase 1/2 sessions and token paths intact", () => {
		const table = liveRouter.routes.map(
			(route) => `${route.method} ${route.path}`,
		);

		expect(table).toContain("POST /sessions/:sessionId/token");
		expect(table).toContain("POST /sessions/:sessionId/go-live");
		expect(table).toContain("POST /sessions/:sessionId/cancel");
		expect(table).toContain("DELETE /sessions/:sessionId");
	});
});
