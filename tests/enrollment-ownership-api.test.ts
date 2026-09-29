import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { CacheService } from "@/services/cache.service";
import { JwtService } from "@/services/jwt.service";

/**
 * @info - Enrollment routes, over HTTP.
 *
 * The companion `tests/enrollment-ownership.test.ts` pins the service guards. This
 * suite exists because the guard is only worth anything if the controller actually
 * passes the caller to it: `get` used to take no authData at all and received a
 * raw path param, so the handoff is exactly where this class of defect lives.
 *
 * Before the fix, all three of these answered a token holder with 200:
 *
 *   GET   /enrollments/:id                        -> any enrollment row, by id
 *   GET   /enrollments/:enrollmentId/progress     -> any student's lesson progress
 *   PATCH /enrollments/:enrollmentId/progress/:l  -> write into any enrollment
 *
 * The PATCH is the sharp one: `upsertProgress(enrollmentId, lessonId, _userId)`
 * ignores the user it is handed, so the write landed inside the victim's
 * enrollment, feeding their `progressPercent` and their certificate.
 *
 * Who may read one: the enrolled student, the parent who paid (`enrolledById`) and
 * an admin. The course's instructor deliberately may not — instructor views of a
 * cohort are course-scoped, never by enrollment id.
 *
 * Requires local Postgres + Redis, like every DB-backed test here.
 */

const STUDENT_AUTH = "auth:enroll-student";
const STRANGER_AUTH = "auth:enroll-stranger";
const PARENT_AUTH = "auth:enroll-parent";
const ADMIN_AUTH = "auth:enroll-admin";
const INSTRUCTOR_AUTH = "auth:enroll-instructor";

const STUDENT_EMAIL = "enroll.student@hive.test";
const STRANGER_EMAIL = "enroll.stranger@hive.test";
const PARENT_EMAIL = "enroll.parent@hive.test";
const ADMIN_EMAIL = "enroll.admin@hive.test";
const INSTRUCTOR_EMAIL = "enroll.instructor@hive.test";
const SLUG = "enrollment-ownership-course";

const ALL_EMAILS = `'${STUDENT_EMAIL}', '${STRANGER_EMAIL}', '${PARENT_EMAIL}', '${ADMIN_EMAIL}', '${INSTRUCTOR_EMAIL}'`;

let db: ReturnType<typeof getDb>;
let app: Hono;
const tokens: Record<string, string> = {};
let studentId: number;
let enrollmentId: number;
let lessonId: number;

const sql = async (statement: string) => {
	const result = await db.execute(statement);
	return result.rows as any[];
};
const one = async (statement: string) => (await sql(statement))[0];

/**
 * @info - Ordered children before parents and matched on markers rather than on
 * captured ids, so this is safe as the first act of a run as well as the last.
 * `courses.instructor_id` and `communities.owner_id` are ON DELETE RESTRICT, so a
 * user cannot be deleted while either still references them: the course goes
 * first, then the community this suite made if it made one.
 */
const cleanup = async () => {
	const courseIds = `(SELECT id FROM courses WHERE slug = '${SLUG}')`;
	const moduleIds = `(SELECT id FROM modules WHERE course_id IN ${courseIds})`;
	const lessonIds = `(SELECT id FROM lessons WHERE module_id IN ${moduleIds})`;

	await sql(
		`DELETE FROM lesson_progress WHERE enrollment_id IN (SELECT id FROM enrollments WHERE course_id IN ${courseIds})`,
	);
	await sql(
		`DELETE FROM enrollments WHERE course_id IN ${courseIds} OR user_id IN (SELECT id FROM users WHERE lower(email) IN (${ALL_EMAILS}))`,
	);
	await sql(`DELETE FROM quiz_attempts WHERE lesson_id IN ${lessonIds}`);
	await sql(`DELETE FROM quiz_questions WHERE lesson_id IN ${lessonIds}`);
	await sql(`DELETE FROM lessons WHERE module_id IN ${moduleIds}`);
	await sql(`DELETE FROM modules WHERE course_id IN ${courseIds}`);
	await sql(`DELETE FROM courses WHERE slug = '${SLUG}'`);
	/* @info - The community goes before the users who own it: `communities.owner_id`
	 * is ON DELETE RESTRICT, so the instructor cannot be deleted while it stands. */
	await sql(
		`DELETE FROM communities WHERE slug = 'enrollment-ownership-community'`,
	);
	await sql(`DELETE FROM users WHERE lower(email) IN (${ALL_EMAILS})`);
};

/**
 * @info - Callers pass the auth id (`STUDENT_AUTH`), not a signed token. Resolving
 * the token here keeps one lookup in one place instead of five call sites each
 * reaching into `tokens`, where a key typo would go out as `Bearer undefined` and
 * come back as a 401 that looks like a guard firing.
 */
const get = (path: string, as: string) =>
	app.request(`/api/v1${path}`, {
		headers: { Authorization: `Bearer ${tokens[as]}` },
	});

const patch = (path: string, as: string) =>
	app.request(`/api/v1${path}`, {
		method: "PATCH",
		headers: {
			Authorization: `Bearer ${tokens[as]}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ lastPositionSeconds: 0 }),
	});

beforeAll(async () => {
	await connectPostgresDB(() => {});
	db = getDb();

	await cleanup();

	const { testApp } = await import("./setup");
	app = testApp;
	const jwt = JwtService.getInstance();

	const mkUser = async (first: string, email: string) =>
		(
			await one(
				`INSERT INTO users (first_name, last_name, email, onboarded) VALUES ('${first}', 'Tester', '${email}', true) RETURNING id`,
			)
		).id as number;

	const studentRow = await mkUser("Stu", STUDENT_EMAIL);
	studentId = studentRow;
	const strangerId = await mkUser("Stranger", STRANGER_EMAIL);
	const parentId = await mkUser("Par", PARENT_EMAIL);
	const adminId = await mkUser("Adm", ADMIN_EMAIL);
	const instructorId = await mkUser("Inst", INSTRUCTOR_EMAIL);

	for (const [userId, role] of [
		[studentId, "student"],
		[strangerId, "student"],
		[parentId, "parent"],
		[adminId, "instructor"],
		[instructorId, "instructor"],
	] as const) {
		await sql(
			`INSERT INTO user_roles (user_id, role) VALUES (${userId}, '${role}')`,
		);
	}
	await sql(
		`INSERT INTO user_roles (user_id, role) VALUES (${adminId}, 'admin') ON CONFLICT DO NOTHING`,
	);

	const existingCommunity = await one(
		`SELECT id FROM communities ORDER BY id LIMIT 1`,
	);
	const communityId = existingCommunity
		? existingCommunity.id
		: (
				await one(
					`INSERT INTO communities (name, slug, owner_id) VALUES ('Enrollment Ownership', 'enrollment-ownership-community', ${instructorId}) RETURNING id`,
				)
			).id;

	const courseId = (
		await one(
			`INSERT INTO courses (instructor_id, community_id, title, slug, status)\n\t\t\t VALUES (${instructorId}, ${communityId}, 'Enrollment Ownership', '${SLUG}', 'published') RETURNING id`,
		)
	).id as number;
	const moduleId = (
		await one(
			`INSERT INTO modules (course_id, title, sort_order) VALUES (${courseId}, 'Module', 0) RETURNING id`,
		)
	).id;
	lessonId = (
		await one(
			`INSERT INTO lessons (module_id, title, type, status) VALUES (${moduleId}, 'Lesson', 'text', 'published') RETURNING id`,
		)
	).id;

	/* @info - `enrolledById` is the parent who paid, which is what makes the parent
	 * a legitimate reader of this row. */
	enrollmentId = (
		await one(
			`INSERT INTO enrollments (user_id, course_id, enrolled_by_id, progress_percent) VALUES (${studentId}, ${courseId}, ${parentId}, 0) RETURNING id`,
		)
	).id;

	const cache = CacheService.getInstance();
	const sessions: Array<[string, number, string, string[], string]> = [
		[STUDENT_AUTH, studentId, STUDENT_EMAIL, ["student"], "Stu"],
		[STRANGER_AUTH, strangerId, STRANGER_EMAIL, ["student"], "Stranger"],
		[PARENT_AUTH, parentId, PARENT_EMAIL, ["parent"], "Par"],
		[ADMIN_AUTH, adminId, ADMIN_EMAIL, ["instructor", "admin"], "Adm"],
		[INSTRUCTOR_AUTH, instructorId, INSTRUCTOR_EMAIL, ["instructor"], "Inst"],
	];
	for (const [authId, id, email, roles, firstName] of sessions) {
		tokens[authId] = jwt.generateToken(authId);
		await cache.set(authId, {
			id,
			email,
			firstName,
			roles,
			isAuthenticated: true,
		});
	}
});

afterAll(async () => {
	const cache = CacheService.getInstance();
	for (const authId of Object.keys(tokens)) await cache.delete(authId);
	await cleanup();
});

const bodyOf = async (response: Response) => (await response.json()) as any;

describe("GET /enrollments/:id", () => {
	it("the enrolled student reads their own enrollment", async () => {
		const res = await get(`/enrollments/${enrollmentId}`, STUDENT_AUTH);
		expect(res.status).toBe(200);
		/* @info - `data.data` is the envelope's row: the controller wraps the row in
		 * `{ message, data }` and `sendSuccessResponse` wraps that in its own
		 * `{ timestamp, status, success, data }`. */
		const row = (await bodyOf(res)).data.data;
		expect(row.id).toBe(enrollmentId);
		expect(Number(row.userId)).toBe(studentId);
	});

	it("the parent who paid reads it", async () => {
		const res = await get(`/enrollments/${enrollmentId}`, PARENT_AUTH);
		expect(res.status).toBe(200);
	});

	it("an admin reads it", async () => {
		const res = await get(`/enrollments/${enrollmentId}`, ADMIN_AUTH);
		expect(res.status).toBe(200);
	});

	it("a stranger student is refused and the body carries no part of the row", async () => {
		const res = await get(`/enrollments/${enrollmentId}`, STRANGER_AUTH);
		expect(res.status).toBe(403);

		const body = JSON.stringify(await bodyOf(res));
		expect(body).not.toContain(STUDENT_EMAIL);
		expect(body).not.toContain('"progressPercent"');
	});

	it("the course's instructor is refused: cohort views are course-scoped", async () => {
		const res = await get(`/enrollments/${enrollmentId}`, INSTRUCTOR_AUTH);
		expect(res.status).toBe(403);
	});

	it("404s for an enrollment that does not exist, not 200 with an empty body", async () => {
		const res = await get(`/enrollments/999999999`, STUDENT_AUTH);
		expect(res.status).toBe(404);
		const body = await bodyOf(res);
		expect(body.data).toBeFalsy();
	});
});

describe("GET /enrollments/:enrollmentId/progress", () => {
	it("the enrolled student reads their own progress", async () => {
		const res = await get(
			`/enrollments/${enrollmentId}/progress`,
			STUDENT_AUTH,
		);
		expect(res.status).toBe(200);
	});

	it("a stranger student is refused", async () => {
		const res = await get(
			`/enrollments/${enrollmentId}/progress`,
			STRANGER_AUTH,
		);
		expect(res.status).toBe(403);
	});
});

describe("PATCH /enrollments/:enrollmentId/progress/:lessonId", () => {
	it("a stranger student cannot write, and no progress row appears", async () => {
		const res = await patch(
			`/enrollments/${enrollmentId}/progress/${lessonId}`,
			STRANGER_AUTH,
		);
		expect(res.status).toBe(403);

		const rows = await one(
			`SELECT count(*)::int n FROM lesson_progress WHERE enrollment_id = ${enrollmentId}`,
		);
		expect(rows.n).toBe(0);

		const enrollment = await one(
			`SELECT progress_percent FROM enrollments WHERE id = ${enrollmentId}`,
		);
		expect(Number(enrollment.progress_percent)).toBe(0);
	});

	it("the enrolled student can still complete a lesson", async () => {
		const res = await patch(
			`/enrollments/${enrollmentId}/progress/${lessonId}`,
			STUDENT_AUTH,
		);
		/* @info - 200 with the lesson unmarked would also be a passing test that
		 * proves nothing, so assert BOTH the status and the row. */
		expect(res.status).toBe(200);

		const rows = await one(
			`SELECT completed FROM lesson_progress WHERE enrollment_id = ${enrollmentId} AND lesson_id = ${lessonId}`,
		);
		expect(rows.completed).toBe(true);
	});
});
