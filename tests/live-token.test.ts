import { decode } from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "@/config";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { JwtAction, LessonMeetingType, UserTypes } from "@/enums";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { CalendarService } from "@/modules/calendar";
import { CourseService } from "@/modules/courses/course.service";
import {
	LiveService,
	LiveSessionService,
	roomNameForSession,
} from "@/modules/live";
import { CacheService } from "@/services";

/**
 * @info - Session-keyed live access (phase 1). The lesson-keyed endpoints are gone,
 * so this exercises the session surface directly:
 *
 *  - host            -> publish + roomAdmin
 *  - enrolled student -> publish, no roomAdmin
 *  - community owner/admin / active member -> only for a STANDALONE session
 *    (Decision A, no widening: community membership must not open a paid course's
 *    live class, because a course payment and a community payment are different)
 *  - outsider        -> 403
 *  - external session-> 400 on the token call, url only through the access gate
 *  - ended/cancelled -> 400 for everyone but the host
 *  - go-live/end-live-> host only, idempotent, starts_at stamped once
 *
 * Re-saving a lesson keeps its session's id, kind and link, and deleting a lesson
 * cancels the session with it - otherwise it would keep rendering in the calendar.
 *
 * Creates real rows in a throwaway community/course and cleans them up.
 */
describe("LiveService session access", () => {
	const service = LiveService.getInstance();
	let db: ReturnType<typeof getDb>;

	const stamp = Date.now();

	let hostUserId: number;
	let enrolledUserId: number;
	let memberUserId: number;
	let communityAdminUserId: number;
	let outsiderUserId: number;
	let otherHostUserId: number;
	let communityId: number;
	let courseId: number;
	let moduleId: number;
	let nativeSessionId: number;
	let externalSessionId: number;
	let standaloneSessionId: number;
	let otherHostSessionId: number;
	let nativeLessonId: number;
	let externalLessonId: number;

	const decodeGrants = (jwt: string) => {
		const payload = decode(jwt) as { video?: Record<string, unknown> };
		const grants = payload.video ?? {};
		return {
			room: grants.room as string,
			canPublish: grants.canPublish as boolean,
			canSubscribe: grants.canSubscribe as boolean,
			canPublishData: grants.canPublishData as boolean,
			roomAdmin: grants.roomAdmin as boolean | undefined,
		};
	};

	beforeAll(async () => {
		await connectPostgresDB(() => {});
		db = getDb();

		/* @info - Join tokens are rate limited per user (5/min); clear the window so a
		 * rerun inside the same minute cannot fail for the wrong reason. */
		const redis = CacheService.getInstance().getRedisClient();
		const keys = await redis.keys("ratelimit:livetoken:*");
		if (keys.length) await redis.del(...keys);

		const makeUser = async (email: string) => {
			const r = await db.execute(
				`INSERT INTO users (first_name, last_name, email, email_verified, onboarded)
				 VALUES ('Live', 'Test', '${email}', true, true) RETURNING id`,
			);
			return (r.rows[0] as { id: number }).id;
		};

		hostUserId = await makeUser(`live-host-${stamp}@test.local`);
		enrolledUserId = await makeUser(`live-enrolled-${stamp}@test.local`);
		memberUserId = await makeUser(`live-member-${stamp}@test.local`);
		communityAdminUserId = await makeUser(`live-admin-${stamp}@test.local`);
		outsiderUserId = await makeUser(`live-outsider-${stamp}@test.local`);
		otherHostUserId = await makeUser(`live-otherhost-${stamp}@test.local`);

		const communityRows = await db.execute(
			`INSERT INTO communities (owner_id, name, slug)
			 VALUES (${hostUserId}, 'Live Test Community', 'live-test-comm-${stamp}')
			 RETURNING id`,
		);
		communityId = (communityRows.rows[0] as { id: number }).id;

		const courseRows = await db.execute(
			`INSERT INTO courses (instructor_id, community_id, title, slug, status, category, price)
			 VALUES (${hostUserId}, ${communityId}, 'Live Test Course', 'live-test-${stamp}', 'published', 'test', 0)
			 RETURNING id`,
		);
		courseId = (courseRows.rows[0] as { id: number }).id;

		const modRows = await db.execute(
			`INSERT INTO modules (course_id, title, sort_order)
			 VALUES (${courseId}, 'Live Test Module', 999) RETURNING id`,
		);
		moduleId = (modRows.rows[0] as { id: number }).id;

		/* @info - enrolled student: enrollment only, deliberately NOT a community member */
		await db.execute(
			`INSERT INTO enrollments (user_id, course_id) VALUES (${enrolledUserId}, ${courseId})`,
		);

		/* @info - members: one plain member, one community admin; neither is enrolled */
		await db.execute(
			`INSERT INTO community_members (community_id, user_id, role, member_role, status)
			 VALUES (${communityId}, ${memberUserId}, 'student', 'member', 'active'),
			        (${communityId}, ${communityAdminUserId}, 'student', 'admin', 'active')`,
		);

		const makeSession = async (
			kind: string,
			title: string,
			courseIdValue: number | null,
			hostIdValue: number = hostUserId,
		) => {
			const r = await db.execute(
				`INSERT INTO live_sessions (kind, community_id, course_id, host_id, title, starts_at, duration_minutes)
				 VALUES ('${kind}', ${communityId}, ${courseIdValue ?? "NULL"}, ${hostIdValue}, '${title}', now() + interval '1 day', 60)
				 RETURNING id`,
			);
			return (r.rows[0] as { id: number }).id;
		};

		nativeSessionId = await makeSession("native", "Native Session", courseId);
		externalSessionId = await makeSession(
			"external",
			"External Session",
			courseId,
		);
		standaloneSessionId = await makeSession("native", "Standalone Event", null);
		/* @info - Same course, a different host: exercises the course-instructor
		 * branch, which the rest of the fixture cannot reach because the course
		 * instructor is also the session host. */
		otherHostSessionId = await makeSession(
			"native",
			"Other Host Session",
			courseId,
			otherHostUserId,
		);

		const lessonRows = await db.execute(
			`INSERT INTO lessons (module_id, title, type, status, sort_order, live_session_id)
			 VALUES (${moduleId}, 'Native Session', 'live', 'published', 0, ${nativeSessionId}),
			        (${moduleId}, 'External Session', 'live', 'published', 1, ${externalSessionId})
			 RETURNING id`,
		);
		expect(lessonRows.rows).toHaveLength(2);
		nativeLessonId = (
			(
				await db.execute(
					`SELECT id FROM lessons WHERE live_session_id = ${nativeSessionId}`,
				)
			).rows[0] as { id: number }
		).id;
		externalLessonId = (
			(
				await db.execute(
					`SELECT id FROM lessons WHERE live_session_id = ${externalSessionId}`,
				)
			).rows[0] as { id: number }
		).id;

		await db.execute(
			`UPDATE live_sessions SET meeting_url = 'https://meet.example/ext'
			 WHERE id = ${externalSessionId}`,
		);
	});

	afterAll(async () => {
		await db.execute(
			`DELETE FROM lessons WHERE live_session_id IN (${nativeSessionId}, ${externalSessionId})`,
		);
		await db.execute(
			`DELETE FROM live_sessions WHERE id IN (${nativeSessionId}, ${externalSessionId}, ${standaloneSessionId}, ${otherHostSessionId})`,
		);
		await db.execute(`DELETE FROM enrollments WHERE course_id = ${courseId}`);
		await db.execute(`DELETE FROM modules WHERE id = ${moduleId}`);
		await db.execute(`DELETE FROM courses WHERE id = ${courseId}`);
		await db.execute(
			`DELETE FROM community_members WHERE community_id = ${communityId}`,
		);
		await db.execute(`DELETE FROM communities WHERE id = ${communityId}`);
		await db.execute(
			`DELETE FROM users WHERE id IN (${hostUserId}, ${enrolledUserId}, ${memberUserId}, ${communityAdminUserId}, ${outsiderUserId}, ${otherHostUserId})`,
		);
	});

	const auth = (id: number): IAuthData => ({
		id,
		authId: String(id),
		action: JwtAction.AUTHENTICATE,
		userType: UserTypes.USER,
		firstName: "Live",
		lastName: "Test",
	});

	it("gives the host publish rights, roomAdmin, and the session room name", async () => {
		const res = await service.issueToken(auth(hostUserId), nativeSessionId);
		expect(res.roomName).toBe(roomNameForSession(nativeSessionId));
		expect(res.roomName).toBe(
			`${config.livekit.roomPrefix}session-${nativeSessionId}`,
		);
		expect(res.expiresIn).toBe(7200);
		expect(res.session.isHost).toBe(true);

		const grants = decodeGrants(res.token);
		expect(grants.room).toBe(res.roomName);
		expect(grants.canPublish).toBe(true);
		expect(grants.canSubscribe).toBe(true);
		expect(grants.canPublishData).toBe(true);
		expect(grants.roomAdmin).toBe(true);
	});

	it("gives an enrolled student publish rights without roomAdmin", async () => {
		const res = await service.issueToken(auth(enrolledUserId), nativeSessionId);
		expect(res.session.isHost).toBe(false);

		const grants = decodeGrants(res.token);
		expect(grants.canPublish).toBe(true);
		expect(grants.canSubscribe).toBe(true);
		expect(grants.roomAdmin).toBeFalsy();
	});

	it("does NOT widen a lesson session to community members or owners/admins", async () => {
		await expect(
			service.issueToken(auth(memberUserId), nativeSessionId),
		).rejects.toThrow(/not enrolled/i);
		await expect(
			service.issueToken(auth(communityAdminUserId), nativeSessionId),
		).rejects.toThrow(/not enrolled/i);
	});

	it("rejects an outsider", async () => {
		await expect(
			service.issueToken(auth(outsiderUserId), nativeSessionId),
		).rejects.toThrow(/not enrolled/i);
	});

	it("gates a standalone session on community membership", async () => {
		const member = await service.issueToken(
			auth(memberUserId),
			standaloneSessionId,
		);
		expect(decodeGrants(member.token).canPublish).toBe(true);
		expect(decodeGrants(member.token).roomAdmin).toBeFalsy();

		const admin = await service.issueToken(
			auth(communityAdminUserId),
			standaloneSessionId,
		);
		expect(decodeGrants(admin.token).roomAdmin).toBe(true);

		/* enrollment in the community's course is not membership of the community */
		await expect(
			service.issueToken(auth(enrolledUserId), standaloneSessionId),
		).rejects.toThrow(/not part of this community/i);
		await expect(
			service.issueToken(auth(outsiderUserId), standaloneSessionId),
		).rejects.toThrow(/not part of this community/i);
	});

	it("rejects a token for an external session", async () => {
		await expect(
			service.issueToken(auth(hostUserId), externalSessionId),
		).rejects.toThrow(/no Hive room/i);
	});

	it("returns session detail with the lesson and the meeting url", async () => {
		const view = await service.getSession(
			auth(enrolledUserId),
			nativeSessionId,
		);
		expect(view).toMatchObject({
			id: nativeSessionId,
			kind: "native",
			title: "Native Session",
			status: "scheduled",
			isHost: false,
			canJoin: true,
			lesson: { title: "Native Session" },
		});

		const standalone = await service.getSession(
			auth(memberUserId),
			standaloneSessionId,
		);
		expect(standalone.lesson).toBeNull();

		const external = await service.getSession(
			auth(enrolledUserId),
			externalSessionId,
		);
		expect(external.meetingUrl).toBe("https://meet.example/ext");
	});

	it("hides a session from someone who is not entitled to it", async () => {
		await expect(
			service.getSession(auth(outsiderUserId), nativeSessionId),
		).rejects.toThrow(/not enrolled/i);
	});

	it("moves session state as the host, idempotently, stamping starts_at once", async () => {
		const ended = await service.endLive(auth(hostUserId), standaloneSessionId);
		expect(ended.status).toBe("ended");
		const endedAgain = await service.endLive(
			auth(hostUserId),
			standaloneSessionId,
		);
		expect(endedAgain.status).toBe("ended");

		await db.execute(
			`UPDATE live_sessions SET starts_at = NULL WHERE id = ${standaloneSessionId}`,
		);
		const live = await service.goLive(auth(hostUserId), standaloneSessionId);
		expect(live.status).toBe("live");

		const [first] = (
			await db.execute(
				`SELECT starts_at FROM live_sessions WHERE id = ${standaloneSessionId}`,
			)
		).rows as { starts_at: Date }[];
		expect(first!.starts_at).not.toBeNull();

		const liveAgain = await service.goLive(
			auth(hostUserId),
			standaloneSessionId,
		);
		expect(liveAgain.status).toBe("live");
		const [second] = (
			await db.execute(
				`SELECT starts_at FROM live_sessions WHERE id = ${standaloneSessionId}`,
			)
		).rows as { starts_at: Date }[];
		expect(new Date(second!.starts_at).toISOString()).toBe(
			new Date(first!.starts_at).toISOString(),
		);
	});

	it("refuses host-only state changes from everyone else", async () => {
		await expect(
			service.goLive(auth(memberUserId), standaloneSessionId),
		).rejects.toThrow(/only the host/i);
		await expect(
			service.endLive(auth(enrolledUserId), nativeSessionId),
		).rejects.toThrow(/only the host/i);
		await expect(
			service.goLive(auth(hostUserId), externalSessionId),
		).rejects.toThrow(/no Hive room/i);
	});

	it("blocks participants from a finished session but lets the host reconnect", async () => {
		await db.execute(
			`UPDATE live_sessions SET status = 'ended' WHERE id = ${nativeSessionId}`,
		);
		await expect(
			service.issueToken(auth(enrolledUserId), nativeSessionId),
		).rejects.toThrow(/has ended/i);
		const host = await service.issueToken(auth(hostUserId), nativeSessionId);
		expect(host.session.status).toBe("ended");

		/* the room page still renders, but canJoin is false for a participant */
		const view = await service.getSession(
			auth(enrolledUserId),
			nativeSessionId,
		);
		expect(view.canJoin).toBe(false);

		await db.execute(
			`UPDATE live_sessions SET status = 'cancelled' WHERE id = ${nativeSessionId}`,
		);
		await expect(
			service.issueToken(auth(enrolledUserId), nativeSessionId),
		).rejects.toThrow(/has ended/i);
		await db.execute(
			`UPDATE live_sessions SET status = 'scheduled' WHERE id = ${nativeSessionId}`,
		);
	});

	it("404s an unknown or deleted session", async () => {
		await expect(
			service.getSession(auth(hostUserId), 987654321),
		).rejects.toThrow(/session not found/i);

		await db.execute(
			`UPDATE live_sessions SET deleted_at = now() WHERE id = ${standaloneSessionId}`,
		);
		await expect(
			service.getSession(auth(hostUserId), standaloneSessionId),
		).rejects.toThrow(/session not found/i);
		await db.execute(
			`UPDATE live_sessions SET deleted_at = NULL WHERE id = ${standaloneSessionId}`,
		);
	});

	it("lets the course instructor run a session that another host owns", async () => {
		/* host_id is a different user, but the course instructor still runs the
		 * class - this is the non-host-instructor row of the access matrix */
		const res = await service.issueToken(auth(hostUserId), otherHostSessionId);
		expect(res.session.isHost).toBe(true);

		const grants = decodeGrants(res.token);
		expect(grants.canPublish).toBe(true);
		expect(grants.roomAdmin).toBe(true);
	});

	it("keeps a session's id, kind and link when the lesson is saved again", async () => {
		const sessions = LiveSessionService.getInstance();

		const updated = await sessions.syncLessonMeeting(externalLessonId, {
			meetingType: LessonMeetingType.EXTERNAL,
		});
		expect(updated!.id).toBe(externalSessionId);
		expect(updated!.kind).toBe("external");
		/* the save carried no url - the stored link must survive it */
		expect(updated!.meetingUrl).toBe("https://meet.example/ext");
	});

	it("refuses to change a session's kind and leaves the row untouched", async () => {
		const sessions = LiveSessionService.getInstance();

		await expect(
			sessions.syncLessonMeeting(nativeLessonId, {
				meetingType: LessonMeetingType.EXTERNAL,
				meetingUrl: "https://meet.example/switched",
			}),
		).rejects.toThrow(/cannot be changed.*set the type to none/i);

		const row = await sessions.loadById(nativeSessionId);
		expect(row.kind).toBe("native");
		expect(row.meetingUrl).toBeNull();
	});

	it("cancels the session when its lesson is deleted", async () => {
		const anchor = new Date(
			Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 15, 12),
		);
		const month = anchor.toISOString().slice(0, 7);
		const created = await db.execute(
			`INSERT INTO live_sessions (kind, community_id, course_id, host_id, title, starts_at, duration_minutes)
			 VALUES ('native', ${communityId}, ${courseId}, ${hostUserId}, 'Doomed Session', '${anchor.toISOString()}', 60) RETURNING id`,
		);
		const doomedSessionId = (created.rows[0] as { id: number }).id;
		const lesson = await db.execute(
			`INSERT INTO lessons (module_id, title, type, status, sort_order, live_session_id)
			 VALUES (${moduleId}, 'Doomed Lesson', 'live', 'published', 2, ${doomedSessionId}) RETURNING id`,
		);
		const doomedLessonId = (lesson.rows[0] as { id: number }).id;

		const calendar = CalendarService.getInstance();
		const before = await calendar.listEvents(auth(hostUserId), month);
		expect(before.some((e) => e.data.sessionId === doomedSessionId)).toBe(true);

		await CourseService.getInstance().deleteLesson(
			auth(hostUserId),
			doomedLessonId,
		);

		const [row] = (
			await db.execute(
				`SELECT status, deleted_at FROM live_sessions WHERE id = ${doomedSessionId}`,
			)
		).rows as { status: string; deleted_at: Date | null }[];
		expect(row!.status).toBe("cancelled");
		expect(row!.deleted_at).not.toBeNull();

		/* the lesson row is hard-deleted, so the link cannot come back */
		const lessonsLeft = await db.execute(
			`SELECT id FROM lessons WHERE id = ${doomedLessonId}`,
		);
		expect(lessonsLeft.rows).toHaveLength(0);

		const after = await calendar.listEvents(auth(hostUserId), month);
		expect(after.some((e) => e.data.sessionId === doomedSessionId)).toBe(false);
		await expect(
			service.getSession(auth(hostUserId), doomedSessionId),
		).rejects.toThrow(/session not found/i);

		await db.execute(`DELETE FROM live_sessions WHERE id = ${doomedSessionId}`);
	});
});
