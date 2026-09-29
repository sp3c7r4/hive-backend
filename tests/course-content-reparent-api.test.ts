import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { CacheService } from "@/services/cache.service";
import { JwtService } from "@/services/jwt.service";

/**
 * @info - Course content cannot be re-parented by smuggling the parent id.
 *
 * `moduleRouter`'s five routes DO assert ownership — `assertOwnedModuleCourse`
 * runs in `updateModule`, `deleteModule`, `createLesson`, `updateLesson` and
 * `deleteLesson` — so a stranger is already refused with 403. The hole was
 * narrower than a missing assert and is missed by one:
 *
 *   updateModule:  modulesRepo.update(id, data as any)
 *   updateLesson:  lessonsRepo.update(id, lessonFields as any)
 *
 * Both hand the payload straight to the repository, while the controller passes
 * `await c.req.json()` (the RAW body) rather than `c.req.valid("json")`.
 * `updateModuleSchema` is `createModuleSchema.partial()` and `createLessonSchema`
 * has no `moduleId`, so the zod schemas are written to forbid exactly these keys
 * and never see them. The ownership assert covers the parent they are LEAVING.
 *
 * Before the fix: `PATCH /modules/:id` with `{"courseId": <victim>}` moved a
 * module into a course the caller does not own; `PATCH /modules/:m/lessons/:l`
 * with `{"moduleId": <victim>}` did the same for a lesson.
 *
 * This is a route-level test on purpose: the vulnerability lives in the
 * controller→service handoff, so a service-level test that passes a clean object
 * cannot see it.
 *
 * Requires local Postgres + Redis, like every DB-backed test here.
 */

const OWNER_AUTH = "auth:reparent-owner";
const STRANGER_AUTH = "auth:reparent-stranger";
const OWNER_EMAIL = "reparent.owner@hive.test";
const STRANGER_EMAIL = "reparent.stranger@hive.test";
const SLUG = "reparent-test-course";
const VICTIM_SLUG = "reparent-test-victim";

let db: ReturnType<typeof getDb>;
let app: Hono;
let ownerToken: string;
let strangerToken: string;
let strangerId: number;
let ownerCourseId: number;
let moduleId: number;
let lessonId: number;
let victimCourseId: number;
let victimModuleId: number;
let communityId: number | null = null;

const sql = async (statement: string) => {
	const result = await db.execute(statement);
	return result.rows as any[];
};
const one = async (statement: string) => (await sql(statement))[0];

const cleanup = async () => {
	const allCourses = `(SELECT id FROM courses WHERE slug IN ('${SLUG}', '${VICTIM_SLUG}'))`;
	const allModules = `(SELECT id FROM modules WHERE course_id IN ${allCourses})`;
	const allLessons = `(SELECT id FROM lessons WHERE module_id IN ${allModules})`;

	await sql(`DELETE FROM quiz_attempts WHERE lesson_id IN ${allLessons}`);
	await sql(`DELETE FROM quiz_questions WHERE lesson_id IN ${allLessons}`);
	await sql(`DELETE FROM lessons WHERE module_id IN ${allModules}`);
	await sql(`DELETE FROM modules WHERE course_id IN ${allCourses}`);
	await sql(`DELETE FROM courses WHERE slug IN ('${SLUG}', '${VICTIM_SLUG}')`);
	await sql(
		`DELETE FROM users WHERE lower(email) IN ('${OWNER_EMAIL}', '${STRANGER_EMAIL}')`,
	);
};

const patch = (path: string, token: string, body: unknown) =>
	app.request(`/api/v1${path}`, {
		method: "PATCH",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

beforeAll(async () => {
	await connectPostgresDB(() => {});
	db = getDb();

	await cleanup();

	const { testApp } = await import("./setup");
	app = testApp;
	const jwt = JwtService.getInstance();
	ownerToken = jwt.generateToken(OWNER_AUTH);
	strangerToken = jwt.generateToken(STRANGER_AUTH);

	const mkUser = async (first: string, email: string) =>
		(
			await one(
				`INSERT INTO users (first_name, last_name, email, onboarded) VALUES ('${first}', 'Tester', '${email}', true) RETURNING id`,
			)
		).id as number;

	const ownerId = await mkUser("Own", OWNER_EMAIL);
	strangerId = await mkUser("Stran", STRANGER_EMAIL);
	for (const [userId, role] of [
		[ownerId, "instructor"],
		[strangerId, "instructor"],
	] as const) {
		await sql(
			`INSERT INTO user_roles (user_id, role) VALUES (${userId}, '${role}')`,
		);
	}

	const existingCommunity = await one(
		`SELECT id FROM communities ORDER BY id LIMIT 1`,
	);
	communityId = existingCommunity
		? existingCommunity.id
		: (
				await one(
					`INSERT INTO communities (name, slug, owner_id) VALUES ('Reparent Community', 'reparent-community', ${ownerId}) RETURNING id`,
				)
			).id;

	const mkCourse = async (slug: string, instructorId: number, title: string) =>
		(
			await one(
				`INSERT INTO courses (instructor_id, community_id, title, slug, status)\n\t\t\t VALUES (${instructorId}, ${communityId}, '${title}', '${slug}', 'published') RETURNING id`,
			)
		).id as number;

	ownerCourseId = await mkCourse(SLUG, ownerId, "Reparent Test");
	victimCourseId = await mkCourse(VICTIM_SLUG, strangerId, "Victim Course");

	moduleId = (
		await one(
			`INSERT INTO modules (course_id, title, sort_order) VALUES (${ownerCourseId}, 'My Module', 0) RETURNING id`,
		)
	).id;
	victimModuleId = (
		await one(
			`INSERT INTO modules (course_id, title, sort_order) VALUES (${victimCourseId}, 'Victim Module', 0) RETURNING id`,
		)
	).id;
	lessonId = (
		await one(
			`INSERT INTO lessons (module_id, title, type, status) VALUES (${moduleId}, 'My Lesson', 'text', 'draft') RETURNING id`,
		)
	).id;

	const cache = CacheService.getInstance();
	await cache.set(OWNER_AUTH, {
		id: ownerId,
		email: OWNER_EMAIL,
		firstName: "Own",
		roles: ["instructor"],
		isAuthenticated: true,
	});
	await cache.set(STRANGER_AUTH, {
		id: strangerId,
		email: STRANGER_EMAIL,
		firstName: "Stran",
		roles: ["instructor"],
		isAuthenticated: true,
	});
});

afterAll(async () => {
	const cache = CacheService.getInstance();
	await cache.delete(OWNER_AUTH);
	await cache.delete(STRANGER_AUTH);
	await cleanup();
});

/**
 * @info - Reset the fixture before every test. Without this the suite is
 * order-dependent in a way that hurts exactly when it matters: the pre-fix code
 * really does move the module, so every later test would then be editing a row
 * that now belongs to the stranger's course and would report 403 for the owner.
 * Resetting makes each test readable on its own, red or green.
 */
beforeEach(async () => {
	await sql(
		`UPDATE modules SET course_id = ${ownerCourseId}, title = 'My Module' WHERE id = ${moduleId}`,
	);
	await sql(
		`UPDATE lessons SET module_id = ${moduleId}, title = 'My Lesson', status = 'draft',
		 attachment_url = NULL, settings = NULL WHERE id = ${lessonId}`,
	);
});

describe("PATCH /modules/:id", () => {
	it("403 for a stranger instructor, with the module unchanged", async () => {
		const res = await patch(`/modules/${moduleId}`, strangerToken, {
			title: "hijacked",
		});
		expect(res.status).toBe(403);
		const row = await one(
			`SELECT course_id, title FROM modules WHERE id = ${moduleId}`,
		);
		expect(row.course_id).toBe(ownerCourseId);
		expect(row.title).toBe("My Module");
	});

	it("drops an injected courseId instead of moving the module into another course", async () => {
		const res = await patch(`/modules/${moduleId}`, ownerToken, {
			title: "Renamed",
			courseId: victimCourseId,
		});
		expect(res.status).toBe(200);
		const row = await one(
			`SELECT course_id, title FROM modules WHERE id = ${moduleId}`,
		);
		/* the security property: it stayed in its own course */
		expect(row.course_id).toBe(ownerCourseId);
		/* ...and the module was genuinely renamed, so this is a strip, not a refusal */
		expect(row.title).toBe("Renamed");
		/* ...and it did not land in the victim's course either */
		const inVictim = await sql(
			`SELECT id FROM modules WHERE course_id = ${victimCourseId}`,
		);
		expect(inVictim.map((r: any) => r.id)).toEqual([victimModuleId]);
	});
});

describe("PATCH /modules/:m/lessons/:l", () => {
	it("403 for a stranger instructor, with the lesson unchanged", async () => {
		const res = await patch(
			`/modules/${moduleId}/lessons/${lessonId}`,
			strangerToken,
			{ title: "hijacked" },
		);
		expect(res.status).toBe(403);
		const row = await one(
			`SELECT module_id, title FROM lessons WHERE id = ${lessonId}`,
		);
		expect(row.module_id).toBe(moduleId);
		expect(row.title).toBe("My Lesson");
	});

	it("drops an injected moduleId instead of moving the lesson into another module", async () => {
		const res = await patch(
			`/modules/${moduleId}/lessons/${lessonId}`,
			ownerToken,
			{ title: "Renamed Lesson", moduleId: victimModuleId },
		);
		expect(res.status).toBe(200);
		const row = await one(
			`SELECT module_id, title FROM lessons WHERE id = ${lessonId}`,
		);
		expect(row.module_id).toBe(moduleId);
		expect(row.title).toBe("Renamed Lesson");
		const inVictim = await sql(
			`SELECT id FROM lessons WHERE module_id = ${victimModuleId}`,
		);
		expect(inVictim).toHaveLength(0);
	});

	/**
	 * @info - The regression a strict "schema keys only" whitelist would cause.
	 * The frontend's `UpdateLessonInput` sends fields `createLessonSchema` does not
	 * declare — `status` drives the draft/live toggle, and `attachmentUrl` /
	 * `settings` have their own editors — and today they survive only because the
	 * controller reads the raw body. The whitelist must keep them working.
	 */
	it("still writes the fields the zod schema omits but the lesson editor sends", async () => {
		const res = await patch(
			`/modules/${moduleId}/lessons/${lessonId}`,
			ownerToken,
			{
				status: "published",
				attachmentUrl: "https://example.test/handout.pdf",
				settings: { rubric: { weight: 1 } },
			},
		);
		expect(res.status).toBe(200);
		const row = await one(
			`SELECT status, attachment_url, settings FROM lessons WHERE id = ${lessonId}`,
		);
		expect(row.status).toBe("published");
		expect(row.attachment_url).toBe("https://example.test/handout.pdf");
		expect(row.settings).toMatchObject({ rubric: { weight: 1 } });
	});
});
