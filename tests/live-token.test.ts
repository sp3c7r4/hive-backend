import { eq } from "drizzle-orm";
import { decode } from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "@/config";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { JwtAction, UserTypes } from "@/enums";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { courses, lessons, modules } from "@/modules/courses/course.model";
import { enrollments } from "@/modules/enrollments/enrollment.model";
import { LiveService } from "@/modules/live";

/**
 * @info - Live session token grants (spec 19):
 *  - instructor owns the course -> canPublish (publish + subscribe)
 *  - enrolled student          -> subscribe-only + canPublishData
 *  - non-enrolled user         -> 403
 *  - non-native lesson         -> 400
 * Creates real rows in a throwaway course and cleans them up.
 */
describe("LiveService token grants", () => {
	const service = LiveService.getInstance();
	let db: ReturnType<typeof getDb>;

	const stamp = Date.now();

	let instructorUserId: number;
	let studentUserId: number;
	let outsiderUserId: number;
	let courseId: number;
	let communityId: number;
	let moduleId: number;
	let nativeLessonId: number;
	let externalLessonId: number;

	const decodeGrants = (jwt: string) => {
		const payload = decode(jwt) as { video?: Record<string, unknown> };
		const grants = payload.video ?? {};
		return {
			room: grants.room,
			canPublish: grants.canPublish,
			canSubscribe: grants.canSubscribe,
			canPublishData: grants.canPublishData,
		};
	};

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

		instructorUserId = await makeUser(`live-instr-${stamp}@test.local`);
		studentUserId = await makeUser(`live-student-${stamp}@test.local`);
		outsiderUserId = await makeUser(`live-outsider-${stamp}@test.local`);

		const communityRows = await db.execute(
			`INSERT INTO communities (owner_id, name, slug)
			 VALUES (${instructorUserId}, 'Live Test Community', 'live-test-comm-${stamp}')
			 RETURNING id`,
		);
		communityId = (communityRows.rows[0] as { id: number }).id;

		const courseRows = await db.execute(
			`INSERT INTO courses (instructor_id, community_id, title, slug, status, category, price)
			 VALUES (${instructorUserId}, ${communityId}, 'Live Test Course', 'live-test-${stamp}', 'published', 'test', 0)
			 RETURNING id`,
		);
		courseId = (courseRows.rows[0] as { id: number }).id;

		const modRows = await db.execute(
			`INSERT INTO modules (course_id, title, sort_order) VALUES (${courseId}, 'Live Test Module', 999) RETURNING id`,
		);
		moduleId = (modRows.rows[0] as { id: number }).id;

		const lessonRows = await db.execute(
			`INSERT INTO lessons (module_id, title, type, status, sort_order, meeting_type, duration_minutes)
			 VALUES (${moduleId}, 'Native Session', 'live', 'published', 0, 'native', 60) RETURNING id`,
		);
		nativeLessonId = (lessonRows.rows[0] as { id: number }).id;

		const extRows = await db.execute(
			`INSERT INTO lessons (module_id, title, type, status, sort_order, meeting_type, meeting_url)
			 VALUES (${moduleId}, 'External Meet', 'live', 'published', 1, 'external', 'https://meet.example/x') RETURNING id`,
		);
		externalLessonId = (extRows.rows[0] as { id: number }).id;

		await db.execute(
			`INSERT INTO enrollments (user_id, course_id) VALUES (${studentUserId}, ${courseId})`,
		);
	});

	afterAll(async () => {
		await db.execute(`DELETE FROM enrollments WHERE course_id = ${courseId}`);
		await db.execute(`DELETE FROM lessons WHERE module_id = ${moduleId}`);
		await db.execute(`DELETE FROM modules WHERE id = ${moduleId}`);
		await db.execute(`DELETE FROM courses WHERE id = ${courseId}`);
		await db.execute(`DELETE FROM communities WHERE id = ${communityId}`);
		await db.execute(
			`DELETE FROM users WHERE id IN (${instructorUserId}, ${studentUserId}, ${outsiderUserId})`,
		);
	});

	const auth = (id: number): IAuthData => ({
		id,
		authId: String(id),
		action: JwtAction.AUTHENTICATE,
		userType: UserTypes.USER,
	});

	it("grants publish to the owning instructor", async () => {
		const res = await service.issueToken(
			auth(instructorUserId),
			nativeLessonId,
		);
		expect(res.roomName).toBe(
			`${config.livekit.roomPrefix}lesson-${nativeLessonId}`,
		);
		expect(res.token).toBeTruthy();
		expect(res.expiresIn).toBe(7200);
		const grants = decodeGrants(res.token);
		expect(grants.canPublish).toBe(true);
		expect(grants.canSubscribe).toBe(true);
		expect(grants.canPublishData).toBe(true);
	});

	it("grants subscribe-only to an enrolled student", async () => {
		const res = await service.issueToken(auth(studentUserId), nativeLessonId);
		const grants = decodeGrants(res.token);
		expect(grants.canPublish).toBe(false);
		expect(grants.canSubscribe).toBe(true);
		expect(grants.canPublishData).toBe(true);
	});

	it("rejects a non-enrolled user", async () => {
		await expect(
			service.issueToken(auth(outsiderUserId), nativeLessonId),
		).rejects.toThrow(/not enrolled/i);
	});

	it("rejects tokens for non-native lessons", async () => {
		await expect(
			service.issueToken(auth(instructorUserId), externalLessonId),
		).rejects.toThrow(/no LiveKit session/i);
	});

	it("moves session state as the instructor", async () => {
		const live = await service.goLive(auth(instructorUserId), nativeLessonId);
		expect(live.liveStatus).toBe("live");

		const [row] = await db
			.select({ liveStatus: lessons.liveStatus })
			.from(lessons)
			.where(eq(lessons.id, nativeLessonId))
			.limit(1);
		expect(row?.liveStatus).toBe("live");

		const ended = await service.endLive(auth(instructorUserId), nativeLessonId);
		expect(ended.liveStatus).toBe("ended");
	});

	it("rejects state changes from a non-owner", async () => {
		await expect(
			service.goLive(auth(studentUserId), nativeLessonId),
		).rejects.toThrow(/do not own/i);
	});
});
