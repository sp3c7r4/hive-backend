import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { CacheService } from "@/services/cache.service";
import { JwtService } from "@/services/jwt.service";

/**
 * @info - Quiz authorization over the real HTTP routes, the real service and real
 * rows. Before the ownership guards went in, `GET /quiz/attempts/course/:courseId`
 * answered 200 for any user holding the instructor role regardless of who owned
 * the course, returning student names, emails and scores; the builder routes let
 * another instructor read, rewrite and delete questions by guessing an id.
 *
 * These are the route-level companions to `quiz-ownership.test.ts` (which stubs
 * repositories and needs no infrastructure).
 *
 * Requires the same local infrastructure as every DB-backed test in this repo
 * (`docker compose -f docker-compose.dev.yml up -d`, `npm run migrate`) plus
 * Redis, because a protected route resolves its session from it. Everything is
 * created in a throwaway course/users and deleted afterwards.
 */

const OWNER_AUTH = "auth:quiz-ownership-owner";
const STRANGER_AUTH = "auth:quiz-ownership-stranger";
const STUDENT_AUTH = "auth:quiz-ownership-student";
const OWNER_EMAIL = "quiz.ownership.owner@hive.test";
const STRANGER_EMAIL = "quiz.ownership.stranger@hive.test";
const STUDENT_EMAIL = "quiz.ownership.student@hive.test";
const SLUG = "quiz-ownership-test-course";
const COMMUNITY_SLUG = "quiz-ownership-community";

let db: ReturnType<typeof getDb>;
let app: Hono;
let ownerToken: string;
let strangerToken: string;
let studentToken: string;
let ownerId: number;
let strangerId: number;
let studentId: number;
let courseId: number;
let lessonId: number;
let questionId: number;
/** @info - A lesson in a course the owner does NOT own: the target of the
 *  relocation attempt below. */
let foreignLessonId: number;
let communityId: number | null = null;

const sql = async (statement: string) => {
	const result = await db.execute(statement);
	return result.rows as any[];
};

const one = async (statement: string) => (await sql(statement))[0];

/** @info - Identified by unique markers rather than captured ids, so a run that
 *  died midway cannot poison the next one. */
/**
 * @info - Identified by unique markers (slugs, emails) rather than captured ids, so
 * this is safe to call at the START of a run as well as the end: a run that died
 * midway leaves rows behind, and the next run's first act is to clear them.
 *
 * ORDER IS LOAD-BEARING. `communities.owner_id` and `courses.instructor_id` are
 * both `ON DELETE RESTRICT`, so a test user who owns a community cannot be deleted
 * until that community is gone — and on a database with no communities the first
 * run CREATES one, which is exactly when the user delete would fail. Children
 * before parents, communities before users.
 */
const cleanup = async () => {
	const courseIds = `(SELECT id FROM courses WHERE slug = '${SLUG}')`;
	const moduleIds = `(SELECT id FROM modules WHERE course_id IN ${courseIds})`;
	const lessonIds = `(SELECT id FROM lessons WHERE module_id IN ${moduleIds})`;

	await sql(`DELETE FROM quiz_attempts WHERE lesson_id IN ${lessonIds}`);
	await sql(`DELETE FROM quiz_questions WHERE lesson_id IN ${lessonIds}`);
	await sql(`DELETE FROM lessons WHERE module_id IN ${moduleIds}`);
	await sql(`DELETE FROM modules WHERE course_id IN ${courseIds}`);
	await sql(`DELETE FROM courses WHERE slug = '${SLUG}'`);
	await sql(`DELETE FROM courses WHERE slug = '${SLUG}-foreign'`);
	/* @info - Before the users: RESTRICT, and only our own slug, never a community
	 * the fixture reused from elsewhere. */
	await sql(`DELETE FROM communities WHERE slug = '${COMMUNITY_SLUG}'`);
	await sql(
		`DELETE FROM users WHERE lower(email) IN ('${OWNER_EMAIL}', '${STRANGER_EMAIL}', '${STUDENT_EMAIL}')`,
	);
};

const request = (
	path: string,
	token: string,
	init: { method?: string; body?: unknown } = {},
) =>
	app.request(`/api/v1${path}`, {
		method: init.method ?? "GET",
		headers: {
			Authorization: `Bearer ${token}`,
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
	ownerToken = jwt.generateToken(OWNER_AUTH);
	strangerToken = jwt.generateToken(STRANGER_AUTH);
	studentToken = jwt.generateToken(STUDENT_AUTH);

	const owner = await one(
		`INSERT INTO users (first_name, last_name, email, onboarded) VALUES ('Own', 'Er', '${OWNER_EMAIL}', true) RETURNING id`,
	);
	ownerId = owner.id;
	const stranger = await one(
		`INSERT INTO users (first_name, last_name, email, onboarded) VALUES ('Stran', 'Ger', '${STRANGER_EMAIL}', true) RETURNING id`,
	);
	strangerId = stranger.id;
	const student = await one(
		`INSERT INTO users (first_name, last_name, email, onboarded) VALUES ('Stud', 'Ent', '${STUDENT_EMAIL}', true) RETURNING id`,
	);
	studentId = student.id;

	for (const [userId, role] of [
		[ownerId, "instructor"],
		[strangerId, "instructor"],
		[studentId, "student"],
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
		const created = await one(
			`INSERT INTO communities (name, slug, owner_id) VALUES ('Quiz Ownership Community', '${COMMUNITY_SLUG}', ${ownerId}) RETURNING id`,
		);
		communityId = created.id;
	}

	const course = await one(
		`INSERT INTO courses (instructor_id, community_id, title, slug, status)
		 VALUES (${ownerId}, ${communityId}, 'Quiz Ownership Test', '${SLUG}', 'published') RETURNING id`,
	);
	courseId = course.id;
	const mod = await one(
		`INSERT INTO modules (course_id, title) VALUES (${courseId}, 'Throwaway Module') RETURNING id`,
	);
	const lesson = await one(
		`INSERT INTO lessons (module_id, title, type, status) VALUES (${mod.id}, 'Owned Quiz', 'quiz', 'published') RETURNING id`,
	);
	lessonId = lesson.id;
	const question = await one(
		`INSERT INTO quiz_questions (lesson_id, text, correct_answer) VALUES (${lessonId}, 'Original question', 'A') RETURNING id`,
	);
	questionId = question.id;

	/* @info - A lesson the owner does NOT own, to prove a question cannot be
	 * relocated out of their course by smuggling `lessonId` past the schema. */
	const foreignCourse = await one(
		`INSERT INTO courses (instructor_id, community_id, title, slug, status)
		 VALUES (${strangerId}, ${communityId}, 'Foreign Course', '${SLUG}-foreign', 'published') RETURNING id`,
	);
	const foreignModule = await one(
		`INSERT INTO modules (course_id, title) VALUES (${foreignCourse.id}, 'Foreign Module') RETURNING id`,
	);
	const foreignLesson = await one(
		`INSERT INTO lessons (module_id, title, type, status) VALUES (${foreignModule.id}, 'Foreign Quiz', 'quiz', 'published') RETURNING id`,
	);
	foreignLessonId = foreignLesson.id;

	/* @info - One real attempt by the student, so `listByCourse` has actual student
	 * rows to (not) leak. Without it the endpoint returns an empty array even on a
	 * 200, and the 403 body assertion below would hold no matter what. */
	await sql(
		`INSERT INTO quiz_attempts (user_id, lesson_id, question_id, selected_answer, is_correct)
		 VALUES (${studentId}, ${lessonId}, ${questionId}, 'A', true)`,
	);

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
	await cache.set(STUDENT_AUTH, {
		id: studentId,
		email: STUDENT_EMAIL,
		firstName: "Stud",
		roles: ["student"],
		isAuthenticated: true,
	});
});

afterAll(async () => {
	const cache = CacheService.getInstance();
	await cache.delete(OWNER_AUTH);
	await cache.delete(STRANGER_AUTH);
	await cache.delete(STUDENT_AUTH);
	await cleanup();
});

describe("GET /quiz/attempts/course/:courseId", () => {
	it("200 for the instructor who owns the course, with the student's rows", async () => {
		const res = await request(`/quiz/attempts/course/${courseId}`, ownerToken);
		expect(res.status).toBe(200);
		/* @info - Proves the payload really carries student PII, which is what makes
		 * the 403 assertion below meaningful rather than vacuous. */
		expect(JSON.stringify(await res.json())).toContain(STUDENT_EMAIL);
	});

	it("403 for an instructor who does not own the course", async () => {
		const res = await request(
			`/quiz/attempts/course/${courseId}`,
			strangerToken,
		);
		expect(res.status).toBe(403);
		/* @info - The refusal must not leak the payload it was refusing. */
		const body = JSON.stringify(await res.json());
		expect(body).not.toContain(STUDENT_EMAIL);
		expect(body).not.toContain(OWNER_EMAIL);
	});

	/* @info - This route also carries `requireInstructor`, which rejects a student
	 * before the ownership guard runs. The test pins the role guard; the ownership
	 * check is pinned by the stranger-instructor cases either side of it. */
	it("403 for a student, refused by the instructor role guard", async () => {
		const res = await request(
			`/quiz/attempts/course/${courseId}`,
			studentToken,
		);
		expect(res.status).toBe(403);
	});
});

describe("quiz builder routes", () => {
	it("403 when a stranger lists another instructor's lesson questions", async () => {
		const res = await request(
			`/quiz/lessons/${lessonId}/questions`,
			strangerToken,
		);
		expect(res.status).toBe(403);
	});

	it("403 when a stranger creates a question on another instructor's lesson", async () => {
		const res = await request(
			`/quiz/lessons/${lessonId}/questions`,
			strangerToken,
			{
				method: "POST",
				body: { text: "injected", correctAnswer: "x" },
			},
		);
		expect(res.status).toBe(403);
		const rows = await sql(
			`SELECT count(*)::int AS n FROM quiz_questions WHERE lesson_id = ${lessonId}`,
		);
		expect(rows[0].n).toBe(1);
	});

	it("403 when a stranger rewrites another instructor's question", async () => {
		const res = await request(`/quiz/questions/${questionId}`, strangerToken, {
			method: "PATCH",
			body: { text: "rewritten by a stranger" },
		});
		expect(res.status).toBe(403);
		const row = await one(
			`SELECT text FROM quiz_questions WHERE id = ${questionId}`,
		);
		expect(row.text).toBe("Original question");
	});

	it("403 when a stranger deletes another instructor's question", async () => {
		const res = await request(`/quiz/questions/${questionId}`, strangerToken, {
			method: "DELETE",
		});
		expect(res.status).toBe(403);
		const rows = await sql(
			`SELECT count(*)::int AS n FROM quiz_questions WHERE id = ${questionId}`,
		);
		expect(rows[0].n).toBe(1);
	});

	/* @info - Role guard again, not the ownership check (see the note on the
	 * results route above). */
	it("403 when a student reads a question, refused by the role guard", async () => {
		const res = await request(`/quiz/questions/${questionId}`, studentToken);
		expect(res.status).toBe(403);
	});

	it("200 when the owning instructor reads their own question", async () => {
		const res = await request(`/quiz/questions/${questionId}`, ownerToken);
		expect(res.status).toBe(200);
	});

	it("404 for a question that does not exist", async () => {
		const res = await request(`/quiz/questions/99999999`, ownerToken);
		expect(res.status).toBe(404);
	});

	it("cannot relocate its own question into another instructor's lesson", async () => {
		/* @info - `updateQuizQuestionSchema` omits `lessonId`, so the contract says a
		 * question cannot be moved. The schema's output is only reachable through
		 * `c.req.valid()`; a handler reading the raw body lets `lessonId` through, and
		 * `assertOwnedQuestionCourse` only covers the lesson the question is LEAVING,
		 * so an instructor could inject content into a course they do not own. */
		const res = await request(`/quiz/questions/${questionId}`, ownerToken, {
			method: "PATCH",
			body: { lessonId: foreignLessonId, text: "relocated" },
		});

		const row = await one(
			`SELECT lesson_id, text FROM quiz_questions WHERE id = ${questionId}`,
		);
		/* The security property: the question never leaves its own lesson. */
		expect(row.lesson_id).toBe(lessonId);
		/* ...and the rest of the patch still worked, so this is a strip, not a blanket refusal. */
		expect(res.status).toBe(200);
		expect(row.text).toBe("relocated");
	});
});
