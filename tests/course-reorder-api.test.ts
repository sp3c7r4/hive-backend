import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { CacheService } from "@/services/cache.service";
import { JwtService } from "@/services/jwt.service";

/**
 * @info - Bulk reorder for modules and lessons.
 *
 * Route-level on purpose: the contract under test is the route chain itself
 * (guard order, the set check, the lock order in the transaction), not one
 * service method.
 *
 * Every status assertion also asserts the body. A missing route answers 404
 * with "Route PATCH /api/v1/... does not exist" from `routeNotFound`, so a bare
 * `expect(res.status).toBe(404)` would pass before any of this exists and prove
 * nothing. Asserting the message keeps the red state honest: the suite fails
 * because the handler is absent, not because the number 404 appeared.
 *
 * Requires local Postgres + Redis, like every DB-backed test here.
 */

const OWNER_AUTH = "auth:reorder-owner";
const STRANGER_AUTH = "auth:reorder-stranger";
const STUDENT_AUTH = "auth:reorder-student";
const ADMIN_AUTH = "auth:reorder-admin";
const ADMIN_INSTRUCTOR_AUTH = "auth:reorder-admin-instructor";

const OWNER_EMAIL = "reorder.owner@hive.test";
const STRANGER_EMAIL = "reorder.stranger@hive.test";
const STUDENT_EMAIL = "reorder.student@hive.test";
const ADMIN_EMAIL = "reorder.admin@hive.test";
const ADMIN_INSTRUCTOR_EMAIL = "reorder.admin.instructor@hive.test";

const SLUG = "reorder-test-course";
const STRANGER_SLUG = "reorder-test-stranger";
const COMMUNITY_SLUG = "reorder-test-community";

const ROLE_REFUSED =
	"Instructor access required. Please select the instructor role first.";
const OWNERSHIP_REFUSED = "You don't have permission to modify this course.";
const MODULES_MISMATCH =
	"The order must list every module in this course exactly once.";
const LESSONS_MISMATCH =
	"The order must list every lesson in this module exactly once.";

let db: ReturnType<typeof getDb>;
let app: Hono;
let ownerToken: string;
let strangerToken: string;
let studentToken: string;
let adminToken: string;
let adminInstructorToken: string;

let ownerCourseId: number;
let strangerCourseId: number;
/** The course whose modules get reordered: three modules. */
let moduleAId: number;
let moduleBId: number;
let moduleCId: number;
/** A module of the same course whose lessons are never reordered. */
let untouchedModuleId: number;
/** A module of the stranger's course: the "id from another parent" case. */
let strangerModuleId: number;
/** Three lessons of module A, plus one lesson of module B. */
let lessonIds: number[] = [];
let otherModuleLessonId: number;

const sql = async (statement: string) => {
	const result = await db.execute(statement);
	return result.rows as any[];
};
const one = async (statement: string) => (await sql(statement))[0];

/**
 * @info - Identified by unique markers rather than captured ids, so this is safe
 * to call at the start of a run as well as the end. Children before parents:
 * `courses.instructor_id` and `communities.owner_id` are ON DELETE RESTRICT.
 */
const cleanup = async () => {
	const allCourses = `(SELECT id FROM courses WHERE slug IN ('${SLUG}', '${STRANGER_SLUG}'))`;
	const allModules = `(SELECT id FROM modules WHERE course_id IN ${allCourses})`;

	await sql(
		`DELETE FROM quiz_attempts WHERE lesson_id IN (SELECT id FROM lessons WHERE module_id IN ${allModules})`,
	);
	await sql(
		`DELETE FROM quiz_questions WHERE lesson_id IN (SELECT id FROM lessons WHERE module_id IN ${allModules})`,
	);
	await sql(`DELETE FROM lessons WHERE module_id IN ${allModules}`);
	await sql(`DELETE FROM modules WHERE course_id IN ${allCourses}`);
	await sql(
		`DELETE FROM courses WHERE slug IN ('${SLUG}', '${STRANGER_SLUG}')`,
	);
	await sql(`DELETE FROM communities WHERE slug = '${COMMUNITY_SLUG}'`);
	await sql(
		`DELETE FROM users WHERE lower(email) IN ('${OWNER_EMAIL}', '${STRANGER_EMAIL}', '${STUDENT_EMAIL}', '${ADMIN_EMAIL}', '${ADMIN_INSTRUCTOR_EMAIL}')`,
	);
};

const patch = async (path: string, token: string | null, body: unknown) => {
	const res = await app.request(`/api/v1${path}`, {
		method: "PATCH",
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	return { status: res.status, body: (await res.json()) as any };
};

const get = async (path: string, token: string) => {
	const res = await app.request(`/api/v1${path}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	return { status: res.status, body: (await res.json()) as any };
};

/**
 * @info - The list controllers answer `sendSuccessResponse(c, { message, data })`, so the
 * array sits at `body.data.data`. Read it defensively: while the routes do not exist the
 * body is a router 404 and every assertion below should fail with a readable diff rather
 * than a TypeError.
 */
const rowsOf = (res: { body: any }): any[] =>
	(res.body?.data?.data ?? []) as any[];

/** Ids of a course's modules, in the order the API returns them. */
const storedModuleIds = async (courseId: number, token = ownerToken) => {
	const res = await get(`/courses/${courseId}/modules`, token);
	return rowsOf(res).map((m: any) => m.id as number);
};

/** Ids of a module's lessons, in the order the API returns them. */
const storedLessonIds = async (moduleId: number, token = ownerToken) => {
	const res = await get(`/modules/${moduleId}/lessons`, token);
	return rowsOf(res).map((l: any) => l.id as number);
};

const sortOrdersOf = async (table: "modules" | "lessons", parentId: number) => {
	const rows = await sql(
		table === "modules"
			? `SELECT id, sort_order FROM modules WHERE course_id = ${parentId} ORDER BY sort_order, id`
			: `SELECT id, sort_order FROM lessons WHERE module_id = ${parentId} ORDER BY sort_order, id`,
	);
	return rows.map((r) => Number(r.sort_order));
};

/** Rotate left by one: a second, distinct permutation of the same set. */
const rotated = <T>(list: T[]): T[] => [...list.slice(1), list[0] as T];

beforeAll(async () => {
	await connectPostgresDB(() => {});
	db = getDb();

	await cleanup();

	const { testApp } = await import("./setup");
	app = testApp;
	const jwt = JwtService.getInstance();
	ownerToken = jwt.generateToken(OWNER_AUTH);
	strangerToken = jwt.generateToken(STRANGER_AUTH);
	studentToken = jwt.generateToken(STUDENT_AUTH);
	adminToken = jwt.generateToken(ADMIN_AUTH);
	adminInstructorToken = jwt.generateToken(ADMIN_INSTRUCTOR_AUTH);

	const mkUser = async (first: string, email: string) =>
		(
			await one(
				`INSERT INTO users (first_name, last_name, email, onboarded) VALUES ('${first}', 'Tester', '${email}', true) RETURNING id`,
			)
		).id as number;

	const ownerId = await mkUser("Own", OWNER_EMAIL);
	const strangerId = await mkUser("Stran", STRANGER_EMAIL);
	const studentId = await mkUser("Stud", STUDENT_EMAIL);
	const adminId = await mkUser("Adm", ADMIN_EMAIL);
	const adminInstructorId = await mkUser("AdmIns", ADMIN_INSTRUCTOR_EMAIL);

	for (const [userId, role] of [
		[ownerId, "instructor"],
		[strangerId, "instructor"],
		[studentId, "student"],
		/* @info - The admin who is NOT an instructor: refused by requireInstructor,
		 * which asks user_roles for the instructor role rather than "admin or
		 * instructor". */
		[adminId, "admin"],
		[adminInstructorId, "admin"],
		[adminInstructorId, "instructor"],
	] as const) {
		await sql(
			`INSERT INTO user_roles (user_id, role) VALUES (${userId}, '${role}')`,
		);
	}

	const existingCommunity = await one(
		`SELECT id FROM communities ORDER BY id LIMIT 1`,
	);
	const communityId =
		existingCommunity?.id ??
		(
			await one(
				`INSERT INTO communities (name, slug, owner_id) VALUES ('Reorder Community', '${COMMUNITY_SLUG}', ${ownerId}) RETURNING id`,
			)
		).id;

	const mkCourse = async (slug: string, instructorId: number, title: string) =>
		(
			await one(
				`INSERT INTO courses (instructor_id, community_id, title, slug, status) VALUES (${instructorId}, ${communityId}, '${title}', '${slug}', 'published') RETURNING id`,
			)
		).id as number;

	const mkModule = async (courseId: number, title: string, sortOrder: number) =>
		(
			await one(
				`INSERT INTO modules (course_id, title, sort_order) VALUES (${courseId}, '${title}', ${sortOrder}) RETURNING id`,
			)
		).id as number;

	const mkLesson = async (moduleId: number, title: string, sortOrder: number) =>
		(
			await one(
				`INSERT INTO lessons (module_id, title, type, status, sort_order) VALUES (${moduleId}, '${title}', 'text', 'published', ${sortOrder}) RETURNING id`,
			)
		).id as number;

	ownerCourseId = await mkCourse(SLUG, ownerId, "Reorder Test");
	strangerCourseId = await mkCourse(
		STRANGER_SLUG,
		strangerId,
		"Reorder Stranger",
	);

	moduleAId = await mkModule(ownerCourseId, "Module A", 0);
	moduleBId = await mkModule(ownerCourseId, "Module B", 1);
	moduleCId = await mkModule(ownerCourseId, "Module C", 2);
	/* @info - Not reordered by any test, except the "extra id" one naming a module
	 * of ANOTHER parent. */
	untouchedModuleId = await mkModule(ownerCourseId, "Module D", 3);
	strangerModuleId = await mkModule(strangerCourseId, "Stranger Module", 0);

	lessonIds = [
		await mkLesson(moduleAId, "Lesson 1", 0),
		await mkLesson(moduleAId, "Lesson 2", 1),
		await mkLesson(moduleAId, "Lesson 3", 2),
	];
	otherModuleLessonId = await mkLesson(moduleBId, "Other module lesson", 0);

	const cache = CacheService.getInstance();
	const sessions: [string, number, string, string[]][] = [
		[OWNER_AUTH, ownerId, OWNER_EMAIL, ["instructor"]],
		[STRANGER_AUTH, strangerId, STRANGER_EMAIL, ["instructor"]],
		[STUDENT_AUTH, studentId, STUDENT_EMAIL, ["student"]],
		[ADMIN_AUTH, adminId, ADMIN_EMAIL, ["admin"]],
		[
			ADMIN_INSTRUCTOR_AUTH,
			adminInstructorId,
			ADMIN_INSTRUCTOR_EMAIL,
			["admin", "instructor"],
		],
	];
	for (const [key, id, email, roles] of sessions) {
		await cache.set(key, {
			id,
			email,
			firstName: "Tester",
			roles,
			isAuthenticated: true,
		});
	}
});

afterAll(async () => {
	const cache = CacheService.getInstance();
	for (const key of [
		OWNER_AUTH,
		STRANGER_AUTH,
		STUDENT_AUTH,
		ADMIN_AUTH,
		ADMIN_INSTRUCTOR_AUTH,
	]) {
		await cache.delete(key);
	}
	await cleanup();
});

describe("PATCH /courses/:courseId/modules/order", () => {
	it("reorders the modules and returns them in the order sent", async () => {
		const sent = [moduleCId, moduleBId, moduleAId, untouchedModuleId];
		const res = await patch(
			`/courses/${ownerCourseId}/modules/order`,
			ownerToken,
			{ ids: sent },
		);

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		expect(rowsOf(res).map((m: any) => m.id)).toEqual(sent);
		expect(rowsOf(res).map((m: any) => m.sortOrder)).toEqual([0, 1, 2, 3]);
		expect(await storedModuleIds(ownerCourseId)).toEqual(sent);
	});

	it("normalizes duplicate sort_order values left behind by the old arrows", async () => {
		/* @info - Two modules at the same position: legal, because there is no unique
		 * constraint on (course_id, sort_order). */
		await sql(
			`UPDATE modules SET sort_order = 0 WHERE id IN (${moduleAId}, ${moduleBId})`,
		);

		const sent = await storedModuleIds(ownerCourseId);
		const res = await patch(
			`/courses/${ownerCourseId}/modules/order`,
			ownerToken,
			{ ids: sent },
		);

		expect(res.status).toBe(200);
		expect(await sortOrdersOf("modules", ownerCourseId)).toEqual([0, 1, 2, 3]);
	});

	it("400 for a list that is missing an id, and nothing is written", async () => {
		const before = await storedModuleIds(ownerCourseId);
		const res = await patch(
			`/courses/${ownerCourseId}/modules/order`,
			ownerToken,
			{
				ids: before.slice(0, -1),
			},
		);

		expect(res.status).toBe(400);
		expect(res.body.error.message).toBe(MODULES_MISMATCH);
		expect(await storedModuleIds(ownerCourseId)).toEqual(before);
	});

	it("400 for a list carrying a module of another course, and that module stays put", async () => {
		const before = await storedModuleIds(ownerCourseId);
		const res = await patch(
			`/courses/${ownerCourseId}/modules/order`,
			ownerToken,
			{
				ids: [...before.slice(0, -1), strangerModuleId],
			},
		);

		expect(res.status).toBe(400);
		expect(res.body.error.message).toBe(MODULES_MISMATCH);
		expect(await storedModuleIds(ownerCourseId)).toEqual(before);
		/* @info - Asserted on sort_order, the only column the endpoint writes: a
		 * course_id assertion passes even if the refused request had rewritten the other
		 * parent's children. */
		expect(await sortOrdersOf("modules", strangerCourseId)).toEqual([0]);
		expect(await storedModuleIds(strangerCourseId, strangerToken)).toEqual([
			strangerModuleId,
		]);
	});

	it("400 for a duplicated id", async () => {
		const before = await storedModuleIds(ownerCourseId);
		const res = await patch(
			`/courses/${ownerCourseId}/modules/order`,
			ownerToken,
			{
				ids: [before[0], before[0], ...before.slice(2)],
			},
		);

		expect(res.status).toBe(400);
		expect(res.body.error.message).toBe(MODULES_MISMATCH);
		expect(await storedModuleIds(ownerCourseId)).toEqual(before);
	});

	it("400 for an id appended twice, and not one of them is written", async () => {
		const before = await storedModuleIds(ownerCourseId);
		const orders = await sortOrdersOf("modules", ownerCourseId);
		const res = await patch(
			`/courses/${ownerCourseId}/modules/order`,
			ownerToken,
			{ ids: [...before, before[0]] },
		);

		expect(res.status).toBe(400);
		expect(res.body.error.message).toBe(MODULES_MISMATCH);
		expect(await storedModuleIds(ownerCourseId)).toEqual(before);
		expect(await sortOrdersOf("modules", ownerCourseId)).toEqual(orders);
	});

	it("400 with a field error for a malformed body as an instructor, and for ids that are not positive integers", async () => {
		const before = await storedModuleIds(ownerCourseId);

		const notAnArray = await patch(
			`/courses/${ownerCourseId}/modules/order`,
			ownerToken,
			{ ids: "not-an-array" },
		);
		expect(notAnArray.status).toBe(400);
		expect(notAnArray.body.error.ids).toBeTruthy();

		for (const ids of [[1.5], [-1], [0], ["3"], [before[0], null]]) {
			const res = await patch(
				`/courses/${ownerCourseId}/modules/order`,
				ownerToken,
				{ ids },
			);
			expect(res.status, `ids: ${JSON.stringify(ids)}`).toBe(400);
			expect(
				Object.keys(res.body.error ?? {}).some((k) => k.startsWith("ids")),
				`ids: ${JSON.stringify(ids)}`,
			).toBe(true);
		}

		expect(await storedModuleIds(ownerCourseId)).toEqual(before);
	});

	it("400 for an empty list", async () => {
		const res = await patch(
			`/courses/${ownerCourseId}/modules/order`,
			ownerToken,
			{ ids: [] },
		);

		expect(res.status).toBe(400);
		expect(String(res.body.error.ids)).toContain(">=1");
	});

	it("400 for a list past the cap", async () => {
		const ids = Array.from({ length: 501 }, (_, i) => i + 1);
		const res = await patch(
			`/courses/${ownerCourseId}/modules/order`,
			ownerToken,
			{ ids },
		);

		expect(res.status).toBe(400);
		expect(String(res.body.error.ids)).toContain("500");
	});

	it("400 for an unknown key in the body", async () => {
		const sent = await storedModuleIds(ownerCourseId);
		const res = await patch(
			`/courses/${ownerCourseId}/modules/order`,
			ownerToken,
			{
				ids: sent,
				sortOrder: 5,
			},
		);

		expect(res.status).toBe(400);
		expect(JSON.stringify(res.body.error)).toContain("sortOrder");
	});

	it("404 'Course not found' for an unknown course", async () => {
		const res = await patch("/courses/99999999/modules/order", ownerToken, {
			ids: [1],
		});

		expect(res.status).toBe(404);
		expect(res.body.error.message).toBe("Course not found");
	});

	it("403 for a student, before the body is even looked at", async () => {
		const sent = await storedModuleIds(ownerCourseId);
		const res = await patch(
			`/courses/${ownerCourseId}/modules/order`,
			studentToken,
			{ ids: sent },
		);

		expect(res.status).toBe(403);
		expect(res.body.error.message).toBe(ROLE_REFUSED);

		const malformed = await patch(
			`/courses/${ownerCourseId}/modules/order`,
			studentToken,
			{
				ids: "not-an-array",
			},
		);
		expect(malformed.status).toBe(403);
		expect(malformed.body.error.message).toBe(ROLE_REFUSED);
	});

	it("403 for another instructor's course", async () => {
		const res = await patch(
			`/courses/${ownerCourseId}/modules/order`,
			strangerToken,
			{
				ids: await storedModuleIds(ownerCourseId),
			},
		);

		expect(res.status).toBe(403);
		expect(res.body.error.message).toBe(OWNERSHIP_REFUSED);
	});

	it("401 without a token", async () => {
		const res = await patch(`/courses/${ownerCourseId}/modules/order`, null, {
			ids: [1],
		});

		expect(res.status).toBe(401);
		expect(res.body.error.message).toBe(
			"Token not found. Please ensure Bearer token is provided.",
		);
	});

	it("403 for an admin who does not hold the instructor role", async () => {
		const res = await patch(
			`/courses/${ownerCourseId}/modules/order`,
			adminToken,
			{
				ids: await storedModuleIds(ownerCourseId),
			},
		);

		expect(res.status).toBe(403);
		expect(res.body.error.message).toBe(ROLE_REFUSED);
	});

	it("a reorder by an admin who does hold the instructor role is allowed", async () => {
		const before = await storedModuleIds(ownerCourseId);
		const sent = [...before].reverse();
		const res = await patch(
			`/courses/${ownerCourseId}/modules/order`,
			adminInstructorToken,
			{ ids: sent },
		);

		expect(res.status).toBe(200);
		expect(rowsOf(res).map((m: any) => m.id)).toEqual(sent);
		expect(await storedModuleIds(ownerCourseId)).toEqual(sent);
	});

	it("a refused reorder leaves every sort_order exactly as it was", async () => {
		const before = await sortOrdersOf("modules", ownerCourseId);
		const beforeIds = await storedModuleIds(ownerCourseId);

		const res = await patch(
			`/courses/${ownerCourseId}/modules/order`,
			ownerToken,
			{
				ids: [...beforeIds.slice(1), 99999999],
			},
		);

		expect(res.status).toBe(400);
		expect(res.body.error.message).toBe(MODULES_MISMATCH);
		expect(await sortOrdersOf("modules", ownerCourseId)).toEqual(before);
		expect(await storedModuleIds(ownerCourseId)).toEqual(beforeIds);
	});
});

describe("PATCH /modules/:moduleId/lessons/order", () => {
	it("reorders the lessons and returns them in the order sent", async () => {
		const sent = [lessonIds[2], lessonIds[1], lessonIds[0]];
		const res = await patch(`/modules/${moduleAId}/lessons/order`, ownerToken, {
			ids: sent,
		});

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		expect(rowsOf(res).map((l: any) => l.id)).toEqual(sent);
		expect(rowsOf(res).map((l: any) => l.sortOrder)).toEqual([0, 1, 2]);
		expect(await storedLessonIds(moduleAId)).toEqual(sent);
	});

	it("normalizes duplicate sort_order values for lessons too", async () => {
		await sql(
			`UPDATE lessons SET sort_order = 0 WHERE module_id = ${moduleAId}`,
		);

		const sent = await storedLessonIds(moduleAId);
		const res = await patch(`/modules/${moduleAId}/lessons/order`, ownerToken, {
			ids: sent,
		});

		expect(res.status).toBe(200);
		expect(await sortOrdersOf("lessons", moduleAId)).toEqual([0, 1, 2]);
	});

	it("400 for a missing, extra or duplicated lesson id", async () => {
		const before = await storedLessonIds(moduleAId);

		const missing = await patch(
			`/modules/${moduleAId}/lessons/order`,
			ownerToken,
			{
				ids: before.slice(0, -1),
			},
		);
		expect(missing.status).toBe(400);
		expect(missing.body.error.message).toBe(LESSONS_MISMATCH);

		const extra = await patch(
			`/modules/${moduleAId}/lessons/order`,
			ownerToken,
			{
				ids: [...before.slice(0, -1), otherModuleLessonId],
			},
		);
		expect(extra.status).toBe(400);
		expect(extra.body.error.message).toBe(LESSONS_MISMATCH);

		const duplicated = await patch(
			`/modules/${moduleAId}/lessons/order`,
			ownerToken,
			{
				ids: [before[0], before[0], ...before.slice(2)],
			},
		);
		expect(duplicated.status).toBe(400);
		expect(duplicated.body.error.message).toBe(LESSONS_MISMATCH);

		const appended = await patch(
			`/modules/${moduleAId}/lessons/order`,
			ownerToken,
			{ ids: [...before, before[0]] },
		);
		expect(appended.status).toBe(400);
		expect(appended.body.error.message).toBe(LESSONS_MISMATCH);

		expect(await storedLessonIds(moduleAId)).toEqual(before);
		/* @info - sort_order is the only column the endpoint writes. */
		expect(await sortOrdersOf("lessons", moduleBId)).toEqual([0]);
		expect(await storedLessonIds(moduleBId)).toEqual([otherModuleLessonId]);
	});

	it("reorders a draft lesson too, because the set is every row and not only the published ones", async () => {
		const draftId = (
			await one(
				`INSERT INTO lessons (module_id, title, type, status, sort_order) VALUES (${moduleAId}, 'Draft lesson', 'text', 'draft', 3) RETURNING id`,
			)
		).id as number;
		try {
			const all = await storedLessonIds(moduleAId);
			expect(all).toContain(draftId);

			const omitted = await patch(
				`/modules/${moduleAId}/lessons/order`,
				ownerToken,
				{ ids: all.filter((id: number) => id !== draftId) },
			);
			expect(omitted.status).toBe(400);
			expect(omitted.body.error.message).toBe(LESSONS_MISMATCH);

			const moved = rotated(all);
			const res = await patch(
				`/modules/${moduleAId}/lessons/order`,
				ownerToken,
				{ ids: moved },
			);
			expect(res.status).toBe(200);
			expect(rowsOf(res).map((l: any) => l.id as number)).toEqual(moved);
		} finally {
			await sql(`DELETE FROM lessons WHERE id = ${draftId}`);
		}
	});

	it("404 'Module not found' for an unknown module", async () => {
		const res = await patch("/modules/99999999/lessons/order", ownerToken, {
			ids: [1],
		});

		expect(res.status).toBe(404);
		expect(res.body.error.message).toBe("Module not found");
	});

	it("403 for a student and 403 for another instructor", async () => {
		const sent = await storedLessonIds(moduleAId);

		const student = await patch(
			`/modules/${moduleAId}/lessons/order`,
			studentToken,
			{ ids: sent },
		);
		expect(student.status).toBe(403);
		expect(student.body.error.message).toBe(ROLE_REFUSED);

		const stranger = await patch(
			`/modules/${moduleAId}/lessons/order`,
			strangerToken,
			{ ids: sent },
		);
		expect(stranger.status).toBe(403);
		expect(stranger.body.error.message).toBe(OWNERSHIP_REFUSED);
	});

	it("401 without a token", async () => {
		const res = await patch(`/modules/${moduleAId}/lessons/order`, null, {
			ids: [1],
		});

		expect(res.status).toBe(401);
		expect(res.body.error.message).toBe(
			"Token not found. Please ensure Bearer token is provided.",
		);
	});
});

describe("two reorders of the same list at once", () => {
	/**
	 * @info - The lock order is what this proves: both transactions take the
	 * parent's row lock first and the children in id order, so neither can be
	 * holding a row the other wants. Without that, Postgres answers one of them
	 * with 40P01, `_guard` turns it into a generic 500, and the list can end up
	 * interleaved. Repeated, because a single pair can pass by luck.
	 */
	it("both answer 200 and the stored order is exactly one of the two", async () => {
		const moduloRuns = 5;

		for (let run = 0; run < moduloRuns; run++) {
			const before = await storedModuleIds(ownerCourseId);
			const orderA = [...before].reverse();
			const orderB = rotated(before);

			const [a, b] = await Promise.all([
				patch(`/courses/${ownerCourseId}/modules/order`, ownerToken, {
					ids: orderA,
				}),
				patch(`/courses/${ownerCourseId}/modules/order`, ownerToken, {
					ids: orderB,
				}),
			]);

			expect({ run, statuses: [a.status, b.status] }).toEqual({
				run,
				statuses: [200, 200],
			});
			/* @info - The response is the list read back after the transaction commits, so under
			 * concurrency it may legitimately carry the other request's order: each response only
			 * has to be one of the two, while the stored order below is asserted exactly. */
			const either = [orderA, orderB];
			expect(either).toContainEqual(
				a.body.data?.data?.map((m: any) => m.id) ?? null,
			);
			expect(either).toContainEqual(
				b.body.data?.data?.map((m: any) => m.id) ?? null,
			);

			const stored = await storedModuleIds(ownerCourseId);
			expect([orderA, orderB]).toContainEqual(stored);
			expect(await sortOrdersOf("modules", ownerCourseId)).toEqual([
				0, 1, 2, 3,
			]);
		}
	});

	it("the same for lessons", async () => {
		for (let run = 0; run < 5; run++) {
			const before = await storedLessonIds(moduleAId);
			const orderA = [...before].reverse();
			const orderB = rotated(before);

			const [a, b] = await Promise.all([
				patch(`/modules/${moduleAId}/lessons/order`, ownerToken, {
					ids: orderA,
				}),
				patch(`/modules/${moduleAId}/lessons/order`, ownerToken, {
					ids: orderB,
				}),
			]);

			expect({ run, statuses: [a.status, b.status] }).toEqual({
				run,
				statuses: [200, 200],
			});
			expect([orderA, orderB]).toContainEqual(await storedLessonIds(moduleAId));
			expect(await sortOrdersOf("lessons", moduleAId)).toEqual([0, 1, 2]);
		}
	});
});
