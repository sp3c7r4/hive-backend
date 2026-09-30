import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { CacheService } from "@/services/cache.service";
import { JwtService } from "@/services/jwt.service";

/**
 * @info - A draft lesson is the instructor's, not the student's.
 *
 * `CourseService.listLessons` gated on whether the caller could read the COURSE
 * (`_canReadCourse`) and then returned every lesson in the module. `canRead` is
 * satisfied by an enrolment, so an enrolled student received the unpublished rows:
 * they appeared in the learn page's sidebar and could be opened and played, not
 * merely listed. The draft toggle meant nothing to the one audience it protects.
 *
 * The rule is a collection rule: the owner (and an admin) get the whole tree,
 * because the curriculum builder and the viewer's preview need the unpublished
 * rows; everybody else gets the published ones. This is a route-level test because
 * the distinction lives in `authData`, which the route is responsible for
 * supplying.
 *
 * Requires local Postgres + Redis, like every DB-backed test here.
 */

const OWNER_AUTH = "auth:lesson-visibility-owner";
const STUDENT_AUTH = "auth:lesson-visibility-student";
const ADMIN_AUTH = "auth:lesson-visibility-admin";
const OTHER_AUTH = "auth:lesson-visibility-other";

const OWNER_EMAIL = "lesson.visibility.owner@hive.test";
const STUDENT_EMAIL = "lesson.visibility.student@hive.test";
const ADMIN_EMAIL = "lesson.visibility.admin@hive.test";
const OTHER_EMAIL = "lesson.visibility.other@hive.test";
const SLUG = "lesson-visibility-course";
const COMMUNITY_SLUG = "lesson-visibility-community";

let db: ReturnType<typeof getDb>;
let app: Hono;
const tokens: Record<string, string> = {};
let moduleId: number;
let publishedLessonId: number;
let draftLessonId: number;
let enrollmentId: number;
let communityId: number | null = null;

const sql = async (statement: string) => {
	const result = await db.execute(statement);
	return result.rows as any[];
};
const one = async (statement: string) => (await sql(statement))[0];

/**
 * @info - Marker-based and idempotent, so it is safe both before and after a run.
 * Children before parents, and the community before its owning user: both
 * `communities.owner_id` and `courses.instructor_id` are ON DELETE RESTRICT.
 */
const cleanup = async () => {
	const courses = `(SELECT id FROM courses WHERE slug = '${SLUG}')`;
	const modules = `(SELECT id FROM modules WHERE course_id IN ${courses})`;
	const lessons = `(SELECT id FROM lessons WHERE module_id IN ${modules})`;

	await sql(`DELETE FROM quiz_attempts WHERE lesson_id IN ${lessons}`);
	await sql(`DELETE FROM quiz_questions WHERE lesson_id IN ${lessons}`);
	await sql(`DELETE FROM lesson_progress WHERE lesson_id IN ${lessons}`);
	await sql(`DELETE FROM enrollments WHERE course_id IN ${courses}`);
	await sql(`DELETE FROM lessons WHERE module_id IN ${modules}`);
	await sql(`DELETE FROM modules WHERE course_id IN ${courses}`);
	await sql(`DELETE FROM courses WHERE slug = '${SLUG}'`);
	await sql(`DELETE FROM communities WHERE slug = '${COMMUNITY_SLUG}'`);
	await sql(
		`DELETE FROM users WHERE lower(email) IN ('${OWNER_EMAIL}', '${STUDENT_EMAIL}', '${ADMIN_EMAIL}', '${OTHER_EMAIL}')`,
	);
};

const listLessons = (authId: string, id: number) =>
	app.request(`/api/v1/modules/${id}/lessons`, {
		headers: { Authorization: `Bearer ${tokens[authId]}` },
	});

const titlesOf = async (res: Response) => {
	const body = (await res.json()) as any;
	const rows = (body?.data?.data ?? []) as { id: number; title: string }[];
	return rows.map((row) => row.title);
};

beforeAll(async () => {
	await connectPostgresDB(() => {});
	db = getDb();

	await cleanup();

	const { testApp } = await import("./setup");
	app = testApp;
	const jwt = JwtService.getInstance();
	const cache = CacheService.getInstance();

	const mkUser = async (first: string, email: string, roles: string[]) => {
		const id = (
			await one(
				`INSERT INTO users (first_name, last_name, email, onboarded) VALUES ('${first}', 'Tester', '${email}', true) RETURNING id`,
			)
		).id as number;
		for (const role of roles) {
			await sql(
				`INSERT INTO user_roles (user_id, role) VALUES (${id}, '${role}')`,
			);
		}
		return id;
	};

	const ownerId = await mkUser("Own", OWNER_EMAIL, ["instructor"]);
	const studentId = await mkUser("Stu", STUDENT_EMAIL, ["student"]);
	const adminId = await mkUser("Adm", ADMIN_EMAIL, ["admin"]);
	const otherId = await mkUser("Oth", OTHER_EMAIL, ["instructor"]);

	const existingCommunity = await one(
		`SELECT id FROM communities ORDER BY id LIMIT 1`,
	);
	communityId = existingCommunity
		? existingCommunity.id
		: (
				await one(
					`INSERT INTO communities (name, slug, owner_id) VALUES ('Visibility Community', '${COMMUNITY_SLUG}', ${ownerId}) RETURNING id`,
				)
			).id;

	const courseId = (
		await one(
			`INSERT INTO courses (instructor_id, community_id, title, slug, status) VALUES (${ownerId}, ${communityId}, 'Visibility Course', '${SLUG}', 'published') RETURNING id`,
		)
	).id as number;

	enrollmentId = (
		await one(
			`INSERT INTO enrollments (user_id, course_id, progress_percent) VALUES (${studentId}, ${courseId}, 0) RETURNING id`,
		)
	).id as number;

	moduleId = (
		await one(
			`INSERT INTO modules (course_id, title, sort_order) VALUES (${courseId}, 'Module', 0) RETURNING id`,
		)
	).id as number;

	publishedLessonId = (
		await one(
			`INSERT INTO lessons (module_id, title, type, status) VALUES (${moduleId}, 'Visible lesson', 'text', 'published') RETURNING id`,
		)
	).id as number;
	draftLessonId = (
		await one(
			`INSERT INTO lessons (module_id, title, type, status) VALUES (${moduleId}, 'Unpublished lesson', 'quiz', 'draft') RETURNING id`,
		)
	).id as number;
	await sql(
		`INSERT INTO quiz_questions (lesson_id, type, text, correct_answer) VALUES (${draftLessonId}, 'multiple', 'Hidden question', 'x')`,
	);

	for (const [authId, user, roles] of [
		[OWNER_AUTH, ownerId, ["instructor"]],
		[STUDENT_AUTH, studentId, ["student"]],
		[ADMIN_AUTH, adminId, ["admin"]],
		[OTHER_AUTH, otherId, ["instructor"]],
	] as const) {
		tokens[authId] = jwt.generateToken(authId);
		await cache.set(authId, {
			id: user,
			email:
				authId === OWNER_AUTH
					? OWNER_EMAIL
					: authId === STUDENT_AUTH
						? STUDENT_EMAIL
						: authId === ADMIN_AUTH
							? ADMIN_EMAIL
							: OTHER_EMAIL,
			firstName: "Test",
			roles: [...roles],
			isAuthenticated: true,
		});
	}
}, 60_000);

afterAll(async () => {
	await cleanup();
});

const complete = (authId: string, lessonId: number) =>
	app.request(`/api/v1/enrollments/${enrollmentId}/progress/${lessonId}`, {
		method: "PATCH",
		headers: { Authorization: `Bearer ${tokens[authId]}` },
	});

const take = (authId: string, lessonId: number) =>
	app.request(`/api/v1/quiz/lessons/${lessonId}/take`, {
		headers: { Authorization: `Bearer ${tokens[authId]}` },
	});

describe("who sees an unpublished lesson", () => {
	it("gives the enrolled student the published lesson only", async () => {
		const res = await listLessons(STUDENT_AUTH, moduleId);
		expect(res.status).toBe(200);
		expect(await titlesOf(res)).toEqual(["Visible lesson"]);
	});

	it("keeps the draft lesson out of the student's payload entirely", async () => {
		const body = (await (
			await listLessons(STUDENT_AUTH, moduleId)
		).json()) as any;
		const ids = ((body?.data?.data ?? []) as { id: number }[]).map(
			(row) => row.id,
		);
		expect(ids).not.toContain(draftLessonId);
		expect(ids).toContain(publishedLessonId);
	});

	it("gives the owning instructor both, draft included", async () => {
		const titles = await titlesOf(await listLessons(OWNER_AUTH, moduleId));
		expect(titles).toEqual(["Visible lesson", "Unpublished lesson"]);
	});

	it("gives an admin both, so support can see what an instructor sees", async () => {
		const titles = await titlesOf(await listLessons(ADMIN_AUTH, moduleId));
		expect(titles).toEqual(["Visible lesson", "Unpublished lesson"]);
	});

	it("gives another instructor the published lesson only", async () => {
		const titles = await titlesOf(await listLessons(OTHER_AUTH, moduleId));
		expect(titles).toEqual(["Visible lesson"]);
	});
});

describe("reaching an unpublished lesson by id", () => {
	it("refuses the student's attempt to complete one, and writes nothing", async () => {
		const res = await complete(STUDENT_AUTH, draftLessonId);
		expect(res.status).toBe(403);
		const rows = await sql(
			`SELECT id FROM lesson_progress WHERE enrollment_id = ${enrollmentId} AND lesson_id = ${draftLessonId}`,
		);
		expect(rows).toHaveLength(0);
	});

	it("refuses the student the draft lesson's questions", async () => {
		const res = await take(STUDENT_AUTH, draftLessonId);
		expect(res.status).toBe(403);
		const body = (await res.json()) as any;
		expect(JSON.stringify(body)).not.toContain("Hidden question");
	});

	it("still lets the student complete and open a published lesson", async () => {
		expect((await complete(STUDENT_AUTH, publishedLessonId)).status).toBe(200);
		expect((await take(STUDENT_AUTH, publishedLessonId)).status).toBe(200);
	});

	it("lets the owner open the draft lesson's questions", async () => {
		const res = await take(OWNER_AUTH, draftLessonId);
		expect(res.status).toBe(200);
		expect(JSON.stringify(await res.json())).toContain("Hidden question");
	});
});
