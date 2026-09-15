import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { JwtAction, UserTypes } from "@/enums";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { CalendarService } from "@/modules/calendar";

/**
 * @info - Instructor teaching calendar: CalendarEvent-shaped payloads for live
 * sessions in a month window. Sessions are the single source for both kinds
 * (native rooms and external meeting links) since migration 0028, so this verifies
 * scoping (own sessions only, ended/cancelled excluded), month filtering, the
 * start/end/color/data mapping, and that two sessions sharing a title and a start
 * time stay distinguishable.
 */
describe("CalendarService teaching events", () => {
	const service = CalendarService.getInstance();
	let db: ReturnType<typeof getDb>;

	const stamp = Date.now();
	const now = new Date();
	// @info - Fixed mid-month anchor avoids month-window edge flakiness.
	const anchor = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15, 12),
	);
	const month = anchor.toISOString().slice(0, 7);
	const inMonth = anchor.toISOString();

	let ownerA: number;
	let ownerB: number;
	let courseA: number;
	let courseB: number;
	let moduleA: number;
	let sessionA: number;
	let sessionExternal: number;
	let sessionEnded: number;
	let sessionCancelled: number;
	let sessionOther: number;
	let lessonA: number;

	beforeAll(async () => {
		await connectPostgresDB(() => {});
		db = getDb();

		const makeUser = async (email: string) => {
			const r = await db.execute(
				`INSERT INTO users (first_name, last_name, email, email_verified, onboarded)
				 VALUES ('Cal', 'Test', '${email}', true, true) RETURNING id`,
			);
			return (r.rows[0] as { id: number }).id;
		};

		ownerA = await makeUser(`cal-a-${stamp}@test.local`);
		ownerB = await makeUser(`cal-b-${stamp}@test.local`);

		const makeCourse = async (ownerId: number, tag: string) => {
			const comm = await db.execute(
				`INSERT INTO communities (owner_id, name, slug) VALUES (${ownerId}, 'Cal ${tag}', 'cal-comm-${tag}-${stamp}') RETURNING id`,
			);
			const communityId = (comm.rows[0] as { id: number }).id;
			const course = await db.execute(
				`INSERT INTO courses (instructor_id, community_id, title, slug, status, category, price)
				 VALUES (${ownerId}, ${communityId}, 'Cal Course ${tag}', 'cal-course-${tag}-${stamp}', 'published', 'test', 0)
				 RETURNING id`,
			);
			const courseId = (course.rows[0] as { id: number }).id;
			const mod = await db.execute(
				`INSERT INTO modules (course_id, title, sort_order) VALUES (${courseId}, 'Cal Module ${tag}', 999) RETURNING id`,
			);
			return { courseId, moduleId: (mod.rows[0] as { id: number }).id };
		};

		const a = await makeCourse(ownerA, "a");
		courseA = a.courseId;
		moduleA = a.moduleId;
		const b = await makeCourse(ownerB, "b");
		courseB = b.courseId;
		const moduleB = b.moduleId;

		const makeSession = async (
			hostId: number,
			courseIdValue: number,
			kind: string,
			title: string,
			status: string,
			startsAt: string,
		) => {
			const r = await db.execute(
				`INSERT INTO live_sessions (kind, community_id, course_id, host_id, title, starts_at, duration_minutes, status)
				 SELECT '${kind}', community_id, id, ${hostId}, '${title}', '${startsAt}', 60, '${status}'
				 FROM courses WHERE id = ${courseIdValue}
				 RETURNING id`,
			);
			return (r.rows[0] as { id: number }).id;
		};

		/* @info - the same-title/same-time pair: both must survive as distinct events */
		sessionA = await makeSession(
			ownerA,
			courseA,
			"native",
			"Session",
			"scheduled",
			inMonth,
		);
		sessionExternal = await makeSession(
			ownerA,
			courseA,
			"external",
			"Session",
			"scheduled",
			inMonth,
		);
		sessionEnded = await makeSession(
			ownerA,
			courseA,
			"native",
			"Ended Session",
			"ended",
			inMonth,
		);
		sessionCancelled = await makeSession(
			ownerA,
			courseA,
			"native",
			"Cancelled Session",
			"cancelled",
			inMonth,
		);
		sessionOther = await makeSession(
			ownerB,
			courseB,
			"native",
			"Other Session",
			"scheduled",
			inMonth,
		);

		const lessonRows = await db.execute(
			`INSERT INTO lessons (module_id, title, type, status, sort_order, live_session_id)
			 VALUES (${moduleA}, 'Session', 'live', 'published', 0, ${sessionA})
			 RETURNING id`,
		);
		lessonA = (lessonRows.rows[0] as { id: number }).id;

		/* no lesson points at the external session, so its event carries lessonId: null */
		void moduleB;
		await db.execute(
			`UPDATE live_sessions SET meeting_url = 'https://meet.example/cal' WHERE id = ${sessionExternal}`,
		);
	});

	afterAll(async () => {
		await db.execute(`DELETE FROM lessons WHERE module_id = ${moduleA}`);
		await db.execute(
			`DELETE FROM live_sessions WHERE id IN (${sessionA}, ${sessionExternal}, ${sessionEnded}, ${sessionCancelled}, ${sessionOther})`,
		);
		const wipe = async (courseId: number) => {
			await db.execute(`DELETE FROM modules WHERE course_id = ${courseId}`);
			await db.execute(`DELETE FROM enrollments WHERE course_id = ${courseId}`);
			await db.execute(`DELETE FROM courses WHERE id = ${courseId}`);
		};
		await wipe(courseA);
		await wipe(courseB);
		await db.execute(
			`DELETE FROM communities WHERE owner_id IN (${ownerA}, ${ownerB})`,
		);
		await db.execute(`DELETE FROM users WHERE id IN (${ownerA}, ${ownerB})`);
	});

	const auth = (id: number): IAuthData => ({
		id,
		authId: String(id),
		action: JwtAction.AUTHENTICATE,
		userType: UserTypes.USER,
	});

	it("returns CalendarEvent-shaped rows for own native + external sessions", async () => {
		const events = await service.listEvents(auth(ownerA), month);
		expect(events).toHaveLength(2);

		const ids = events.map((e) => e.id).sort();
		expect(ids).toEqual(
			[`session-${sessionA}`, `session-${sessionExternal}`].sort(),
		);

		const native = events.find((e) => e.id === `session-${sessionA}`)!;
		expect(native.title).toBe("Session");
		expect(native.start).toBe(anchor.toISOString());
		expect(
			new Date(native.end).getTime() - new Date(native.start).getTime(),
		).toBe(60 * 60_000);
		expect(native.color).toBe("#6366F1");
		expect(native.data).toMatchObject({
			sessionId: sessionA,
			lessonId: lessonA,
			courseId: courseA,
			courseTitle: "Cal Course a",
			moduleTitle: "Cal Module a",
			meetingType: "native",
			liveStatus: "scheduled",
		});

		/* the same title and the same start time must not collapse or swap */
		const external = events.find(
			(e) => e.id === `session-${sessionExternal}`,
		)!;
		expect(external.color).toBe("#059669");
		expect(external.data).toMatchObject({
			sessionId: sessionExternal,
			lessonId: null,
			meetingType: "external",
			meetingUrl: "https://meet.example/cal",
		});
	});

	it("excludes ended and cancelled sessions, and other instructors' sessions", async () => {
		const events = await service.listEvents(auth(ownerA), month);
		expect(events.some((e) => e.id === `session-${sessionEnded}`)).toBe(false);
		expect(events.some((e) => e.id === `session-${sessionCancelled}`)).toBe(
			false,
		);
		expect(events.some((e) => e.id === `session-${sessionOther}`)).toBe(false);
	});

	it("returns nothing outside the requested month", async () => {
		const events = await service.listEvents(auth(ownerA), "1999-01");
		expect(events).toHaveLength(0);
	});

	it("rejects a malformed month", async () => {
		await expect(service.listEvents(auth(ownerA), "2026-13")).rejects.toThrow(
			/YYYY-MM/,
		);
		await expect(service.listEvents(auth(ownerA), "junk")).rejects.toThrow(
			/YYYY-MM/,
		);
	});
});
