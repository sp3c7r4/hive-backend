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
const MODULES_SLUG = "leaderboard-modules-course";
const DRAFTS_SLUG = "leaderboard-drafts-course";
const ALL_EMAILS = `'${OWNER_EMAIL}', '${OTHER_EMAIL}', '${STUDENT_EMAIL}', '${STUDENT2_EMAIL}'`;

let db: ReturnType<typeof getDb>;
let app: Hono;
const tokens: Record<string, string> = {};
let ownerId: number;
let studentId: number;
let student2Id: number;
let courseId: number;
let emptyCourseId: number;
/* @info - The module-grouping fixture: a four-module course whose module sort orders
 * deliberately disagree with their creation order, plus a course whose only assessment
 * is a draft (D11). */
let modulesCourseId: number;
let draftsCourseId: number;
let weekOneModule: number;
let weekTwoModule: number;
let weekThreeModule: number;
let resourcesModule: number;
let weekOneAssessment: number;
let weekTwoAssessments: number[] = [];
let weekThreeDraftAssessment: number;
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
	const courseIds = `(SELECT id FROM courses WHERE slug IN ('${SLUG}', '${EMPTY_SLUG}', '${MODULES_SLUG}', '${DRAFTS_SLUG}'))`;
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
	await sql(
		`DELETE FROM courses WHERE slug IN ('${SLUG}', '${EMPTY_SLUG}', '${MODULES_SLUG}', '${DRAFTS_SLUG}')`,
	);
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
		moduleId: number = main.module_,
	) => {
		const lesson = (
			await one(
				`INSERT INTO lessons (module_id, title, type, status, time_limit_minutes) VALUES (${moduleId}, '${title}', '${type}', '${status}', 30) RETURNING id`,
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

	/* @info - The module-grouping fixture. The sort orders disagree with the creation
	 * order on purpose (Week 1 is created first and sorts last, Resources sorts first and
	 * holds no assessment lesson at all), so a board that ordered cards by id, by title or
	 * by the order they were created would fail. Week 2 and Week 3 share a sort order,
	 * which is legal (0 is the column default), so the tie falls to module id and two
	 * reads must not disagree. */
	const mods = await mkCourse(MODULES_SLUG, true);
	modulesCourseId = mods.course;
	const mkModule = async (course: number, title: string, sortOrder: number) =>
		(
			await one(
				`INSERT INTO modules (course_id, title, sort_order) VALUES (${course}, '${title}', ${sortOrder}) RETURNING id`,
			)
		).id as number;

	weekOneModule = await mkModule(modulesCourseId, "Week 1", 3);
	weekTwoModule = await mkModule(modulesCourseId, "Week 2", 1);
	weekThreeModule = await mkModule(modulesCourseId, "Week 3", 1);
	resourcesModule = await mkModule(modulesCourseId, "Resources", 0);

	const w1 = await mkLesson(
		"Week 1 assessment",
		"assessment",
		"published",
		4,
		weekOneModule,
	);
	weekOneAssessment = w1.lesson;
	const w2a = await mkLesson(
		"Week 2 assessment 1",
		"assessment",
		"published",
		2,
		weekTwoModule,
	);
	const w2b = await mkLesson(
		"Week 2 assessment 2",
		"assessment",
		"published",
		2,
		weekTwoModule,
	);
	weekTwoAssessments = [w2a.lesson, w2b.lesson];
	weekThreeDraftAssessment = (
		await mkLesson(
			"Week 3 draft assessment",
			"assessment",
			"draft",
			3,
			weekThreeModule,
		)
	).lesson;
	/* @info - A lesson in Resources, so the module exists and still holds no assessment
	 * lesson: D3 gives it no card. The quiz beside it is the sharper half: it is published
	 * and it has questions, so a query that joined every lesson type would give Resources
	 * a card and pull the quiz into the course scope. */
	await mkLesson("Welcome video", "video", "published", 0, resourcesModule);
	await mkLesson("Practice quiz", "quiz", "published", 2, resourcesModule);

	/* @info - The all-draft course: one module, one assessment, and it is a draft, so the
	 * scope is empty while a card still has to come back (D11). */
	const drafts = await mkCourse(DRAFTS_SLUG, true);
	draftsCourseId = drafts.course;
	await mkLesson(
		"Draft only assessment",
		"assessment",
		"draft",
		3,
		drafts.module_,
	);

	await sql(
		`INSERT INTO enrollments (user_id, course_id, progress_percent) VALUES (${studentId}, ${modulesCourseId}, 50), (${student2Id}, ${modulesCourseId}, 50)`,
	);

	/* @info - Student 1 closes Week 1's single assessment and Week 2's first of two, so
	 * they are ranked in Week 1 (1 of 1 at 100%), partial in Week 2 (1 of 2 at 50%) and
	 * partial over the course (2 of 3, the mean of 100 and 50). Week 1 holding a single
	 * assessment is the point: nobody can be partial in a module that holds one.
	 * Student 2 closes nothing, which is the not-started path at both levels. */
	await seedSession({
		userId: studentId,
		lessonId: weekOneAssessment,
		answers: w1.ids.map((questionId) => ({ questionId, correct: true })),
		minutes: 10,
	});
	await seedSession({
		userId: studentId,
		lessonId: w2a.lesson,
		answers: w2a.ids.map((id, i) => ({ questionId: id, correct: i < 1 })),
		minutes: 20,
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

	it("401 with no token at all", async () => {
		const res = await app.request(`/api/v1/courses/${courseId}/leaderboard`);
		expect(res.status).toBe(401);
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
		/* @info - `modules` is empty too: this fixture course has one module and it
		 * holds no assessment lesson at all, so D3 gives it no card. */
		expect(data).toEqual({ assessments: [], rows: [], unranked: [], modules: [] });
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

	it("returns exactly the assessments the old in-scope predicate returns", async () => {
		/* @info - AC6, and the reason the widened query is trustworthy: the old predicate
		 * is written here as the test's own SQL and run against the same data, so the two
		 * lists are compared against the rule rather than against each other's code. */
		const oldScope = async (course: number) =>
			(
				await sql(`
					SELECT l.id AS lesson_id
					FROM lessons l
					JOIN modules m ON m.id = l.module_id
					WHERE m.course_id = ${course}
						AND l.type = 'assessment'
						AND l.status <> 'draft'
						AND EXISTS (SELECT 1 FROM quiz_questions q WHERE q.lesson_id = l.id)
					ORDER BY l.sort_order, l.id
				`)
			).map((row) => Number(row.lesson_id));

		for (const course of [
			courseId,
			modulesCourseId,
			draftsCourseId,
			emptyCourseId,
		]) {
			const data = (await bodyOf(await board(OWNER_AUTH, course))).data.data;
			expect((data.assessments as any[]).map((a) => a.lessonId)).toEqual(
				await oldScope(course),
			);
		}
	});
});

/**
 * @info - The module view (D1-D4): the same response gains `modules`, one entry per
 * module that holds at least one assessment lesson OF ANY STATUS, ordered by the
 * module's `sort_order` then its id, titles verbatim, each card carrying the same
 * `assessments` / `rows` / `unranked` shape the course level does.
 *
 * Every test asserts the cards' length before reading one, so the red run fails on the
 * new assertion rather than on an undefined property.
 */
describe("GET /courses/:courseId/leaderboard — the module view", () => {
	const moduleView = async (course = modulesCourseId) =>
		(await bodyOf(await board(OWNER_AUTH, course))).data.data;

	it("returns one card per module holding an assessment lesson, in sort_order then id order", async () => {
		const res = await board(OWNER_AUTH, modulesCourseId);
		expect(res.status).toBe(200);
		const data = await moduleView();

		expect(data.modules).toHaveLength(3);
		expect((data.modules as any[]).map((m) => m.moduleId)).toEqual([
			weekTwoModule,
			weekThreeModule,
			weekOneModule,
		]);
		expect((data.modules as any[]).map((m) => m.title)).toEqual([
			"Week 2",
			"Week 3",
			"Week 1",
		]);
		/* @info - Resources holds a video and no assessment lesson, and the module
		 * `mkCourse` made on its own holds nothing: neither gets a card. */
		expect((data.modules as any[]).map((m) => m.moduleId)).not.toContain(
			resourcesModule,
		);

		/* @info - Two modules share a sort order, which is legal, so the tie comes down
		 * to id and two reads must not disagree. */
		const second = await moduleView();
		expect(second.modules).toHaveLength(3);
		expect((second.modules as any[]).map((m) => m.moduleId)).toEqual(
			(data.modules as any[]).map((m) => m.moduleId),
		);
	});

	it("counts each module's own assessments, and only that module's", async () => {
		const data = await moduleView();

		expect(data.modules).toHaveLength(3);
		const [weekTwo, weekThree, weekOne] = data.modules as any[];

		/* @info - Week 1: one assessment, so the one student who sat it is the only
		 * ranked row on the board, and the other is not started. */
		expect(weekOne.assessments.map((a: any) => a.lessonId)).toEqual([
			weekOneAssessment,
		]);
		expect(weekOne).toMatchObject({
			rows: [
				{
					rank: 1,
					userId: studentId,
					completed: 1,
					total: 1,
					averagePercent: 100,
				},
			],
			unranked: [
				{
					userId: student2Id,
					completed: 0,
					total: 1,
					averagePercent: null,
					reason: "not_started",
				},
			],
		});

		/* @info - Week 2: two assessments and only one of them closed, so nobody is
		 * ranked and the partial student's 50% is the mean of the one they sat. */
		expect(weekTwo.assessments.map((a: any) => a.lessonId)).toEqual(
			weekTwoAssessments,
		);
		expect(weekTwo).toMatchObject({
			rows: [],
			unranked: [
				{
					userId: studentId,
					completed: 1,
					total: 2,
					averagePercent: 50,
					reason: "partial",
				},
				{
					userId: student2Id,
					completed: 0,
					total: 2,
					averagePercent: null,
					reason: "not_started",
				},
			],
		});

		/* @info - Week 3's only assessment is a draft: the card exists and is empty, and
		 * its three questions are in nobody's total (AC4). */
		expect(weekThree).toMatchObject({
			assessments: [],
			rows: [],
			unranked: [],
		});
		expect(weekThree.assessments).not.toContain(weekThreeDraftAssessment);

		/* @info - The course level, over the same data: three assessments in scope, the
		 * partial student at 2 of 3 and a mean of the 100 and the 50. */
		expect(data.assessments).toHaveLength(3);
		expect((data.assessments as any[]).map((a) => a.lessonId)).toEqual([
			weekOneAssessment,
			...weekTwoAssessments,
		]);
		expect(data.rows).toEqual([]);
		expect(data.unranked).toEqual([
			expect.objectContaining({
				userId: studentId,
				completed: 2,
				total: 3,
				averagePercent: 75,
				reason: "partial",
			}),
			expect.objectContaining({
				userId: student2Id,
				completed: 0,
				total: 3,
				averagePercent: null,
				reason: "not_started",
			}),
		]);
	});

	it("splits the course level across the cards exactly once each", async () => {
		const data = await moduleView();

		expect(data.modules).toHaveLength(3);
		const fromCards = (data.modules as any[]).flatMap((m) =>
			m.assessments.map((a: any) => a.lessonId),
		);
		expect([...fromCards].sort((a, b) => a - b)).toEqual(
			(data.assessments as any[])
				.map((a) => a.lessonId)
				.sort((a: number, b: number) => a - b),
		);
		expect(new Set(fromCards).size).toBe(fromCards.length);
	});

	it("answers the cards when every assessment in the course is a draft", async () => {
		/* @info - D11: the early return is before the sessions query and still answers
		 * `modules`, with the card present and empty rather than missing. */
		const res = await board(OWNER_AUTH, draftsCourseId);
		expect(res.status).toBe(200);
		const data = await moduleView(draftsCourseId);

		expect(data).toMatchObject({
			assessments: [],
			rows: [],
			unranked: [],
		});
		expect(data.modules).toHaveLength(1);
		expect((data.modules as any[])[0]).toMatchObject({
			title: "Module",
			assessments: [],
			rows: [],
			unranked: [],
		});
	});
});
