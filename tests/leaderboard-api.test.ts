import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { CacheService } from "@/services/cache.service";
import { JwtService } from "@/services/jwt.service";

/**
 * @info - `GET /courses/:courseId/leaderboard`, over HTTP.
 *
 * The board is instructor-only and course-scoped: `requireInstructor` answers "is
 * this person an instructor", never "is this their course", so the ownership check
 * has to be the CourseService one. A student is refused by the role guard.
 *
 * The ranking itself is `rankLeaderboard`'s (tested without a database); what this
 * suite pins is that the QUERY hands it the right plain data — the assessments in
 * scope, the enrolled students, and closed sessions only — plus the JSON shape the
 * screen reads.
 *
 * Requires local Postgres + Redis, like every DB-backed test here.
 */

const OWNER_AUTH = "auth:leaderboard-owner";
const OTHER_AUTH = "auth:leaderboard-other";
const STUDENT_AUTH = "auth:leaderboard-student";
const STUDENT2_AUTH = "auth:leaderboard-student2";

const OWNER_EMAIL = "leaderboard.owner@hive.test";
const OTHER_EMAIL = "leaderboard.other@hive.test";
const STUDENT_EMAIL = "leaderboard.student@hive.test";
const STUDENT2_EMAIL = "leaderboard.student2@hive.test";
const SLUG = "leaderboard-test-course";
const EMPTY_SLUG = "leaderboard-empty-course";
const ALL_EMAILS = `'${OWNER_EMAIL}', '${OTHER_EMAIL}', '${STUDENT_EMAIL}', '${STUDENT2_EMAIL}'`;

let db: ReturnType<typeof getDb>;
let app: Hono;
const tokens: Record<string, string> = {};
let ownerId: number;
let studentId: number;
let student2Id: number;
let courseId: number;
let emptyCourseId: number;
let assessmentA: number;
let assessmentB: number;
let draftAssessment: number;
let questionlessAssessment: number;
let quizLesson: number;
/** @info - The second assessment's question ids: the expired-attempt test scores them. */
let secondAssessmentQuestions: number[] = [];

const sql = async (statement: string) => {
	const result = await db.execute(statement);
	return result.rows as any[];
};
const one = async (statement: string) => (await sql(statement))[0];

/** @info - Children before parents, markers not ids, and the community (RESTRICT)
 *  before the users who own it, so this is safe at the start of a run and at the end. */
const cleanup = async () => {
	const courseIds = `(SELECT id FROM courses WHERE slug IN ('${SLUG}', '${EMPTY_SLUG}'))`;
	const moduleIds = `(SELECT id FROM modules WHERE course_id IN ${courseIds})`;
	const lessonIds = `(SELECT id FROM lessons WHERE module_id IN ${moduleIds})`;

	await sql(
		`DELETE FROM assessment_sessions WHERE lesson_id IN ${lessonIds} OR user_id IN (SELECT id FROM users WHERE lower(email) IN (${ALL_EMAILS}))`,
	);
	await sql(`DELETE FROM quiz_attempts WHERE lesson_id IN ${lessonIds}`);
	await sql(`DELETE FROM quiz_questions WHERE lesson_id IN ${lessonIds}`);
	await sql(
		`DELETE FROM lesson_progress WHERE lesson_id IN ${lessonIds} OR enrollment_id IN (SELECT id FROM enrollments WHERE course_id IN ${courseIds})`,
	);
	await sql(`DELETE FROM enrollments WHERE course_id IN ${courseIds}`);
	await sql(`DELETE FROM lessons WHERE module_id IN ${moduleIds}`);
	await sql(`DELETE FROM modules WHERE course_id IN ${courseIds}`);
	await sql(`DELETE FROM courses WHERE slug IN ('${SLUG}', '${EMPTY_SLUG}')`);
	await sql(`DELETE FROM communities WHERE slug = 'leaderboard-community'`);
	await sql(`DELETE FROM users WHERE lower(email) IN (${ALL_EMAILS})`);
};

const board = (as: string, course = courseId) =>
	app.request(`/api/v1/courses/${course}/leaderboard`, {
		headers: { Authorization: `Bearer ${tokens[as]}` },
	});
const bodyOf = async (response: Response) => (await response.json()) as any;

/** @info - A closed attempt, graded. `minutes` is how long it took. */
const seedSession = async (input: {
	userId: number;
	lessonId: number;
	answers: Array<{ questionId: number; correct: boolean }>;
	minutes: number;
	open?: boolean;
}) => {
	await sql(
		`INSERT INTO assessment_sessions (user_id, lesson_id, started_at, submitted_at)
		 VALUES (${input.userId}, ${input.lessonId}, now() - interval '${input.minutes + 5} minutes',
			${input.open ? "NULL" : `now() - interval '5 minutes'`})`,
	);
	for (const answer of input.answers) {
		/* @info - A wrong row has to LOOK wrong as well as be flagged wrong: the
		 * leaderboard scores an ungraded row by comparing the answer to the question
		 * (D9's grading on read), so a fixture that wrote the correct answer with
		 * is_correct = false would be scored right. */
		await sql(
			`INSERT INTO quiz_attempts (user_id, lesson_id, question_id, selected_answer, is_correct)
			 VALUES (${input.userId}, ${input.lessonId}, ${answer.questionId},
				${answer.correct ? "'x'" : "'wrong'"}, ${answer.correct})`,
		);
	}
};

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

	ownerId = await mkUser("Own", OWNER_EMAIL);
	const otherId = await mkUser("Other", OTHER_EMAIL);
	studentId = await mkUser("Stu", STUDENT_EMAIL);
	student2Id = await mkUser("Ada", STUDENT2_EMAIL);

	for (const [userId, role] of [
		[ownerId, "instructor"],
		[otherId, "instructor"],
		[studentId, "student"],
		[student2Id, "student"],
	] as const) {
		await sql(
			`INSERT INTO user_roles (user_id, role) VALUES (${userId}, '${role}')`,
		);
	}

	const existing = await one(`SELECT id FROM communities ORDER BY id LIMIT 1`);
	const communityId = existing
		? existing.id
		: (
				await one(
					`INSERT INTO communities (name, slug, owner_id) VALUES ('Leaderboard', 'leaderboard-community', ${ownerId}) RETURNING id`,
				)
			).id;

	const mkCourse = async (slug: string, withAssessments: boolean) => {
		const course = (
			await one(
				`INSERT INTO courses (instructor_id, community_id, title, slug, status, offer_certificate, min_completion_percent, min_quiz_score_percent)
				 VALUES (${ownerId}, ${communityId}, '${slug}', '${slug}', 'published', true, 80, 70) RETURNING id`,
			)
		).id as number;
		const module_ = (
			await one(
				`INSERT INTO modules (course_id, title) VALUES (${course}, 'Module') RETURNING id`,
			)
		).id;
		return { course, module_ };
	};

	const main = await mkCourse(SLUG, true);
	courseId = main.course;
	const mkLesson = async (
		title: string,
		type: string,
		status: string,
		questions: number,
	) => {
		const lesson = (
			await one(
				`INSERT INTO lessons (module_id, title, type, status, time_limit_minutes) VALUES (${main.module_}, '${title}', '${type}', '${status}', 30) RETURNING id`,
			)
		).id as number;
		const ids: number[] = [];
		for (let i = 0; i < questions; i++) {
			ids.push(
				(
					await one(
						`INSERT INTO quiz_questions (lesson_id, type, text, correct_answer) VALUES (${lesson}, 'multiple', 'Q${i}', 'x') RETURNING id`,
					)
				).id as number,
			);
		}
		return { lesson, ids };
	};

	const a = await mkLesson("Mid-term", "assessment", "published", 4);
	assessmentA = a.lesson;
	const b = await mkLesson("Final", "assessment", "published", 2);
	assessmentB = b.lesson;
	secondAssessmentQuestions = b.ids;
	/* @info - In scope only if the query filters: a draft, and one with no questions. */
	draftAssessment = (
		await mkLesson("Draft assessment", "assessment", "draft", 2)
	).lesson;
	questionlessAssessment = (
		await mkLesson("Empty assessment", "assessment", "published", 0)
	).lesson;
	quizLesson = (await mkLesson("Practice quiz", "quiz", "published", 2)).lesson;

	/* @info - Two enrolled students, so the board has an order to get wrong. */
	await sql(
		`INSERT INTO enrollments (user_id, course_id, progress_percent) VALUES (${studentId}, ${courseId}, 50), (${student2Id}, ${courseId}, 50)`,
	);

	/* @info - Student 1: both, 100% on the first (4/4) and 50% on the second (1/2),
	 * taking 10 + 20 minutes.
	 * Student 2: only the first, so they are partial. */
	await seedSession({
		userId: studentId,
		lessonId: assessmentA,
		answers: a.ids.map((id, i) => ({ questionId: id, correct: i < 4 })),
		minutes: 10,
	});
	await seedSession({
		userId: studentId,
		lessonId: assessmentB,
		answers: b.ids.map((id, i) => ({ questionId: id, correct: i < 1 })),
		minutes: 20,
	});
	await seedSession({
		userId: student2Id,
		lessonId: assessmentA,
		answers: a.ids.map((id, i) => ({ questionId: id, correct: i < 2 })),
		minutes: 5,
	});

	const empty = await mkCourse(EMPTY_SLUG, false);
	emptyCourseId = empty.course;

	const cache = CacheService.getInstance();
	for (const [authId, id, email, roles, firstName] of [
		[OWNER_AUTH, ownerId, OWNER_EMAIL, ["instructor"], "Own"],
		[OTHER_AUTH, otherId, OTHER_EMAIL, ["instructor"], "Other"],
		[STUDENT_AUTH, studentId, STUDENT_EMAIL, ["student"], "Stu"],
		[STUDENT2_AUTH, student2Id, STUDENT2_EMAIL, ["student"], "Ada"],
	] as const) {
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

describe("GET /courses/:courseId/leaderboard — authorization", () => {
	it("403 for another instructor", async () => {
		const res = await board(OTHER_AUTH);
		expect(res.status).toBe(403);
	});

	it("403 for a student, by the role guard", async () => {
		const res = await board(STUDENT_AUTH);
		expect(res.status).toBe(403);
	});

	it("404 for a course that does not exist", async () => {
		const res = await board(OWNER_AUTH, 999_999_999);
		expect(res.status).toBe(404);
	});
});

describe("GET /courses/:courseId/leaderboard — the board", () => {
	it("ranks the fully-covered student and lists the partial one", async () => {
		const res = await board(OWNER_AUTH);
		expect(res.status).toBe(200);

		const data = (await bodyOf(res)).data.data;
		expect(data.assessments.map((a: any) => a.title).sort()).toEqual([
			"Final",
			"Mid-term",
		]);
		/* @info - The draft and the question-less one are out of scope: a
		 * question-less assessment can never be taken, so requiring it would make
		 * the board unreachable. */
		expect(data.assessments).toHaveLength(2);

		expect(data.rows).toHaveLength(1);
		expect(data.rows[0]).toMatchObject({
			rank: 1,
			userId: studentId,
			name: "Stu T.",
			averagePercent: 75,
			completed: 2,
			total: 2,
		});
		/* 10 + 20 minutes. */
		expect(data.rows[0].totalTimeSeconds).toBe(1800);

		expect(data.unranked).toHaveLength(1);
		expect(data.unranked[0]).toMatchObject({
			userId: student2Id,
			name: "Ada T.",
			completed: 1,
			total: 2,
			reason: "partial",
		});
	});

	it("counts a closed session but not an open one", async () => {
		/* @info - A student who started the second assessment and walked away is
		 * still partial: autosave writes real rows, so an open attempt must not be
		 * graded into a rank. */
		await sql(
			`INSERT INTO assessment_sessions (user_id, lesson_id, started_at, submitted_at)
			 VALUES (${student2Id}, ${assessmentB}, now(), NULL)
			 ON CONFLICT (user_id, lesson_id) DO NOTHING`,
		);
		await sql(
			`INSERT INTO quiz_attempts (user_id, lesson_id, question_id, selected_answer, is_correct)
			 SELECT ${student2Id}, ${assessmentB}, id, 'x', true FROM quiz_questions WHERE lesson_id = ${assessmentB}`,
		);

		const res = await board(OWNER_AUTH);
		const data = (await bodyOf(res)).data.data;
		expect(data.rows).toHaveLength(1);
		expect(data.unranked).toHaveLength(1);
		expect(data.unranked[0].reason).toBe("partial");

		await sql(
			`DELETE FROM assessment_sessions WHERE user_id = ${student2Id} AND lesson_id = ${assessmentB}`,
		);
		await sql(
			`DELETE FROM quiz_attempts WHERE user_id = ${student2Id} AND lesson_id = ${assessmentB}`,
		);
	});

	it("scores an expired attempt on its autosaved answers, without anyone opening it", async () => {
		/* @info - D9: an attempt that ran out of time is graded on what was
		 * autosaved, and nothing schedules that — the student's own attempts view is
		 * where it normally happens. So a board read BEFORE that view still finds
		 * rows with `is_correct = false` on answers that are right, and must not
		 * report them as 0%. This is the case the browser pass caught: a seeded
		 * student showed 0% on the board with one correct answer saved. */
		await sql(
			`INSERT INTO assessment_sessions (user_id, lesson_id, started_at, submitted_at)
			 VALUES (${student2Id}, ${assessmentB}, now() - interval '90 minutes', NULL)
			 ON CONFLICT (user_id, lesson_id) DO UPDATE SET started_at = EXCLUDED.started_at, submitted_at = NULL`,
		);
		for (const [index, questionId] of secondAssessmentQuestions.entries()) {
			await sql(
				`INSERT INTO quiz_attempts (user_id, lesson_id, question_id, selected_answer, is_correct)
				 VALUES (${student2Id}, ${assessmentB}, ${questionId}, ${index === 0 ? "'x'" : "'wrong'"}, false)`,
			);
		}

		const res = await board(OWNER_AUTH);
		const data = (await bodyOf(res)).data.data;
		/* Ada: 2/4 on the first (50%) and 1/2 on the expired second (50%) -> 50. */
		const ada = (data.rows as any[]).find((row) => row.userId === student2Id);
		expect(ada).toBeTruthy();
		expect(ada.averagePercent).toBe(50);

		await sql(
			`DELETE FROM assessment_sessions WHERE user_id = ${student2Id} AND lesson_id = ${assessmentB}`,
		);
		await sql(
			`DELETE FROM quiz_attempts WHERE user_id = ${student2Id} AND lesson_id = ${assessmentB}`,
		);
	});

	it("returns empty lists for a course with no assessments", async () => {
		const res = await board(OWNER_AUTH, emptyCourseId);
		expect(res.status).toBe(200);
		const data = (await bodyOf(res)).data.data;
		expect(data).toEqual({ assessments: [], rows: [], unranked: [] });
	});

	it("does not count a quiz lesson", async () => {
		/* @info - Scored on the same `quiz_attempts` table, but a quiz can be
		 * retaken: ranking on it would let a student drop by taking one again. */
		await sql(
			`INSERT INTO quiz_attempts (user_id, lesson_id, question_id, selected_answer, is_correct)
			 SELECT ${studentId}, ${quizLesson}, id, 'x', true FROM quiz_questions WHERE lesson_id = ${quizLesson}`,
		);
		const res = await board(OWNER_AUTH);
		const data = (await bodyOf(res)).data.data;
		expect(data.assessments.map((a: any) => a.lessonId)).not.toContain(
			quizLesson,
		);
		expect(data.rows[0].averagePercent).toBe(75);
	});

	it("403s an instructor with no access to a course they do not own, even with an id", async () => {
		const res = await board(OTHER_AUTH, emptyCourseId);
		expect(res.status).toBe(403);
	});
});

/** @info - The scope rule, asserted directly on the ids the query returned, because
 *  a title list would pass if the wrong assessment were included by accident. */
describe("GET /courses/:courseId/leaderboard — assessments in scope", () => {
	it("includes only published assessments that have a question", async () => {
		const res = await board(OWNER_AUTH);
		const ids = ((await bodyOf(res)).data.data.assessments as any[]).map(
			(a) => a.lessonId,
		);
		expect(ids.sort()).toEqual([assessmentA, assessmentB].sort());
		expect(ids).not.toContain(draftAssessment);
		expect(ids).not.toContain(questionlessAssessment);
	});
});
