import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { CacheService } from "@/services/cache.service";
import { JwtService } from "@/services/jwt.service";

/**
 * @info - Assignment authorization over the real HTTP routes, the real service and
 * real rows — the route-level companion to `submission-ownership.test.ts`, which
 * stubs repositories and needs no infrastructure.
 *
 * Before the ownership guards went in: any instructor could read any course's
 * submissions, grade any submission on the platform and rewrite any assignment's
 * settings, and `GET /submissions/:submissionId` — carrying no guard beyond a
 * valid token — handed any logged-in user another student's work, its score and
 * the instructor's written feedback.
 *
 * Requires the same local infrastructure as every DB-backed test here
 * (`docker compose -f docker-compose.dev.yml up -d`, `npm run migrate`) plus
 * Redis, because a protected route resolves its session from it.
 */

const OWNER_AUTH = "auth:submission-ownership-owner";
const STRANGER_AUTH = "auth:submission-ownership-stranger";
const AUTHOR_AUTH = "auth:submission-ownership-author";
const OTHER_STUDENT_AUTH = "auth:submission-ownership-other";
const OWNER_EMAIL = "submission.ownership.owner@hive.test";
const STRANGER_EMAIL = "submission.ownership.stranger@hive.test";
const AUTHOR_EMAIL = "submission.ownership.author@hive.test";
const OTHER_STUDENT_EMAIL = "submission.ownership.other@hive.test";
const SLUG = "submission-ownership-test-course";

let db: ReturnType<typeof getDb>;
let app: Hono;
let tokens: Record<string, string>;
let authorId: number;
let otherStudentId: number;
let courseId: number;
let lessonId: number;
let authoredSubmissionId: number;
let otherSubmissionId: number;
let communityId: number | null = null;

const sql = async (statement: string) => {
	const result = await db.execute(statement);
	return result.rows as any[];
};

const one = async (statement: string) => (await sql(statement))[0];

const cleanup = async () => {
	const courseIds = `(SELECT id FROM courses WHERE slug = '${SLUG}')`;
	const moduleIds = `(SELECT id FROM modules WHERE course_id IN ${courseIds})`;
	const lessonIds = `(SELECT id FROM lessons WHERE module_id IN ${moduleIds})`;

	await sql(
		`DELETE FROM assignment_submissions WHERE lesson_id IN ${lessonIds}`,
	);
	await sql(`DELETE FROM lessons WHERE module_id IN ${moduleIds}`);
	await sql(`DELETE FROM modules WHERE course_id IN ${courseIds}`);
	await sql(`DELETE FROM courses WHERE slug = '${SLUG}'`);
	await sql(
		`DELETE FROM users WHERE lower(email) IN ('${OWNER_EMAIL}', '${STRANGER_EMAIL}', '${AUTHOR_EMAIL}', '${OTHER_STUDENT_EMAIL}')`,
	);
};

const request = (
	path: string,
	as: "owner" | "stranger" | "author" | "other",
	init: { method?: string; body?: unknown } = {},
) =>
	app.request(`/api/v1${path}`, {
		method: init.method ?? "GET",
		headers: {
			Authorization: `Bearer ${tokens[as]}`,
			...(init.body ? { "Content-Type": "application/json" } : {}),
		},
		...(init.body ? { body: JSON.stringify(init.body) } : {}),
	});

beforeAll(async () => {
	await connectPostgresDB(() => {});
	db = getDb();

	await cleanup();

	const { testApp } = await import("./setup");
	app = testApp;
	const jwt = JwtService.getInstance();
	tokens = {
		owner: jwt.generateToken(OWNER_AUTH),
		stranger: jwt.generateToken(STRANGER_AUTH),
		author: jwt.generateToken(AUTHOR_AUTH),
		other: jwt.generateToken(OTHER_STUDENT_AUTH),
	};

	const mkUser = async (first: string, last: string, email: string) =>
		(
			await one(
				`INSERT INTO users (first_name, last_name, email, onboarded) VALUES ('${first}', '${last}', '${email}', true) RETURNING id`,
			)
		).id as number;

	const ownerId = await mkUser("Own", "Er", OWNER_EMAIL);
	const strangerId = await mkUser("Stran", "Ger", STRANGER_EMAIL);
	authorId = await mkUser("Auth", "Or", AUTHOR_EMAIL);
	otherStudentId = await mkUser("Oth", "Er", OTHER_STUDENT_EMAIL);

	for (const [userId, role] of [
		[ownerId, "instructor"],
		[strangerId, "instructor"],
		[authorId, "student"],
		[otherStudentId, "student"],
	] as const) {
		await sql(
			`INSERT INTO user_roles (user_id, role) VALUES (${userId}, '${role}')`,
		);
	}

	const existingCommunity = await one(
		`SELECT id FROM communities ORDER BY id LIMIT 1`,
	);
	if (existingCommunity) {
		communityId = existingCommunity.id;
	} else {
		communityId = (
			await one(
				`INSERT INTO communities (name, slug, owner_id) VALUES ('Submission Ownership Community', 'submission-ownership-community', ${ownerId}) RETURNING id`,
			)
		).id;
	}

	courseId = (
		await one(
			`INSERT INTO courses (instructor_id, community_id, title, slug, status)
			 VALUES (${ownerId}, ${communityId}, 'Submission Ownership Test', '${SLUG}', 'published') RETURNING id`,
		)
	).id;
	const mod = await one(
		`INSERT INTO modules (course_id, title) VALUES (${courseId}, 'Throwaway Module') RETURNING id`,
	);
	lessonId = (
		await one(
			`INSERT INTO lessons (module_id, title, type, status) VALUES (${mod.id}, 'Owned Assignment', 'assignment', 'published') RETURNING id`,
		)
	).id;

	authoredSubmissionId = (
		await one(
			`INSERT INTO assignment_submissions (user_id, lesson_id, text, score, feedback)
			 VALUES (${authorId}, ${lessonId}, 'My own coursework', 80, 'Good work') RETURNING id`,
		)
	).id;
	otherSubmissionId = (
		await one(
			`INSERT INTO assignment_submissions (user_id, lesson_id, text, score, feedback)
			 VALUES (${otherStudentId}, ${lessonId}, 'Someone else''s coursework', 55, 'Private feedback') RETURNING id`,
		)
	).id;

	const cache = CacheService.getInstance();
	const session = async (
		authId: string,
		id: number,
		email: string,
		role: string,
	) =>
		cache.set(authId, {
			id,
			email,
			firstName: role === "student" ? "Stud" : "Inst",
			roles: [role],
			isAuthenticated: true,
		});
	await session(OWNER_AUTH, ownerId, OWNER_EMAIL, "instructor");
	await session(STRANGER_AUTH, strangerId, STRANGER_EMAIL, "instructor");
	await session(AUTHOR_AUTH, authorId, AUTHOR_EMAIL, "student");
	await session(
		OTHER_STUDENT_AUTH,
		otherStudentId,
		OTHER_STUDENT_EMAIL,
		"student",
	);
});

afterAll(async () => {
	const cache = CacheService.getInstance();
	for (const key of [
		OWNER_AUTH,
		STRANGER_AUTH,
		AUTHOR_AUTH,
		OTHER_STUDENT_AUTH,
	]) {
		await cache.delete(key);
	}
	await cleanup();
});

describe("GET /submissions/courses/:courseId", () => {
	it("200 for the instructor who owns the course", async () => {
		const res = await request(`/submissions/courses/${courseId}`, "owner");
		expect(res.status).toBe(200);
	});

	it("403 for an instructor who does not own the course", async () => {
		const res = await request(`/submissions/courses/${courseId}`, "stranger");
		expect(res.status).toBe(403);
	});

	/* @info - These three routes also carry `requireInstructor`, which rejects a
	 * student before the ownership guard runs, so the tests below pin the role
	 * guard rather than the ownership check. The ownership check is pinned by the
	 * stranger-instructor cases, and — on the one route with no role guard,
	 * `GET /submissions/:submissionId` — by the "403 for another student" case. */
	it("403 for a student, refused by the instructor role guard", async () => {
		const res = await request(`/submissions/courses/${courseId}`, "author");
		expect(res.status).toBe(403);
	});
});

describe("GET /submissions/:submissionId", () => {
	it("200 for the student who authored it", async () => {
		const res = await request(`/submissions/${authoredSubmissionId}`, "author");
		expect(res.status).toBe(200);
	});

	it("200 for the instructor who owns the course", async () => {
		const res = await request(`/submissions/${authoredSubmissionId}`, "owner");
		expect(res.status).toBe(200);
	});

	it("403 for another student, and the body leaks nothing", async () => {
		const res = await request(`/submissions/${authoredSubmissionId}`, "other");
		expect(res.status).toBe(403);
		const body = JSON.stringify(await res.json());
		expect(body).not.toContain("My own coursework");
		expect(body).not.toContain("Good work");
	});

	it("403 for an instructor who does not own the course", async () => {
		const res = await request(
			`/submissions/${authoredSubmissionId}`,
			"stranger",
		);
		expect(res.status).toBe(403);
		const body = JSON.stringify(await res.json());
		/* @info - This submission's own content, not the sibling fixture's: asserting
		 * for a string that could never appear in this response asserts nothing. */
		expect(body).not.toContain("My own coursework");
		expect(body).not.toContain("Good work");
	});
});

describe("PATCH /submissions/:submissionId/grade", () => {
	it("403 for a stranger instructor, with the row unchanged", async () => {
		const res = await request(
			`/submissions/${otherSubmissionId}/grade`,
			"stranger",
			{ method: "PATCH", body: { score: 100, action: "grade" } },
		);
		expect(res.status).toBe(403);
		const row = await one(
			`SELECT score FROM assignment_submissions WHERE id = ${otherSubmissionId}`,
		);
		expect(row.score).toBe(55);
	});

	it("403 for a student, refused by the instructor role guard", async () => {
		const res = await request(
			`/submissions/${otherSubmissionId}/grade`,
			"author",
			{ method: "PATCH", body: { score: 100, action: "grade" } },
		);
		expect(res.status).toBe(403);
	});
});

describe("PATCH /submissions/lessons/:lessonId/settings", () => {
	it("403 for a stranger instructor, with the lesson settings unchanged", async () => {
		const res = await request(
			`/submissions/lessons/${lessonId}/settings`,
			"stranger",
			{ method: "PATCH", body: { instructions: "rewritten by a stranger" } },
		);
		expect(res.status).toBe(403);
		const row = await one(
			`SELECT settings FROM lessons WHERE id = ${lessonId}`,
		);
		expect(JSON.stringify(row.settings ?? null)).not.toContain("rewritten");
	});

	it("403 for a student, refused by the instructor role guard", async () => {
		const res = await request(
			`/submissions/lessons/${lessonId}/settings`,
			"author",
			{ method: "PATCH", body: { instructions: "student edit" } },
		);
		expect(res.status).toBe(403);
	});
});
