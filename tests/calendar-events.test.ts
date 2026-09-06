import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { JwtAction, UserTypes } from "@/enums";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { CalendarService } from "@/modules/calendar";

/**
 * @info - Instructor teaching calendar (spec 19): CalendarEvent-shaped
 * payloads for live sessions in a month window. Verifies scoping (own
 * courses only, ended/none meetings excluded), month filtering, and the
 * start/end/color/data mapping.
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

	let ownerA: number;
	let ownerB: number;
	let courseA: number;
	let courseB: number;
	let moduleA: number;
	let moduleB: number;
	let nativeLesson: number;
	let externalLesson: number;
	let endedLesson: number;
	let otherLesson: number;

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
		moduleB = b.moduleId;

		const inMonth = anchor.toISOString();

		const insert = async (
			moduleId: number,
			meetingType: string,
			liveStatus: string,
			at: string,
		) => {
			const r = await db.execute(
				`INSERT INTO lessons (module_id, title, type, status, sort_order, meeting_type, meeting_url, scheduled_at, live_status, duration_minutes)
				 VALUES (${moduleId}, 'Session', 'live', 'published', 0, '${meetingType}', NULL, '${at}', '${liveStatus}', 60) RETURNING id`,
			);
			return (r.rows[0] as { id: number }).id;
		};

		nativeLesson = await insert(moduleA, "native", "scheduled", inMonth);
		externalLesson = await insert(moduleA, "external", "scheduled", inMonth);
		endedLesson = await insert(moduleA, "native", "ended", inMonth);
		otherLesson = await insert(moduleB, "native", "scheduled", inMonth);
	});

	afterAll(async () => {
		const wipe = async (moduleId: number, courseId: number) => {
			await db.execute(`DELETE FROM lessons WHERE module_id = ${moduleId}`);
			await db.execute(`DELETE FROM modules WHERE id = ${moduleId}`);
			await db.execute(`DELETE FROM enrollments WHERE course_id = ${courseId}`);
			await db.execute(`DELETE FROM courses WHERE id = ${courseId}`);
		};
		await wipe(moduleA, courseA);
		await wipe(moduleB, courseB);
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
			[`lesson-${externalLesson}`, `lesson-${nativeLesson}`].sort(),
		);

		const native = events.find((e) => e.id === `lesson-${nativeLesson}`)!;
		expect(native.title).toBe("Session");
		expect(native.start).toBe(anchor.toISOString());
		expect(
			new Date(native.end).getTime() - new Date(native.start).getTime(),
		).toBe(60 * 60_000);
		expect(native.color).toBe("#6366F1");
		expect(native.data).toMatchObject({
			courseId: courseA,
			courseTitle: "Cal Course a",
			moduleTitle: "Cal Module a",
			meetingType: "native",
			liveStatus: "scheduled",
		});

		const external = events.find((e) => e.id === `lesson-${externalLesson}`)!;
		expect(external.color).toBe("#059669");
		expect(external.data.meetingType).toBe("external");
	});

	it("excludes ended sessions and other instructors' courses", async () => {
		const events = await service.listEvents(auth(ownerA), month);
		expect(events.some((e) => e.id === `lesson-${endedLesson}`)).toBe(false);
		expect(events.some((e) => e.id === `lesson-${otherLesson}`)).toBe(false);
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
