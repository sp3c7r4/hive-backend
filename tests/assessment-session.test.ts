import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { CacheService } from "@/services/cache.service";
import { QuizMessages } from "@/modules/assessments/quiz.message";
import { JwtService } from "@/services/jwt.service";

/**
 * @info - The assessment attempt endpoints, over HTTP.
 *
 * Three rules are pinned here, each an acceptance check from the spec:
 *
 *   AC18 - `GET /quiz/attempts/:lessonId` must NOT reveal `isCorrect` while an
 *          assessment session is open. Autosave writes the same `quiz_attempts`
 *          rows the endpoint reads back, so before this the endpoint was a live
 *          answer oracle: autosave a guess, read whether it was right, repeat.
 *          `selectedAnswer` must still come back — Resume rehydrates from it.
 *   AC19 - `GET /quiz/lessons/:lessonId/take` must refuse an unstarted
 *          assessment (403): a one-shot exam whose paper is readable before Start
 *          is not one-shot.
 *   The enrollment gate - all three endpoints 403 a caller with no enrollment,
 *          resolved lesson → module → course.
 *
 * Quiz lessons must be unaffected in every one of these states, which is why the
 * suite runs the same assertions against a quiz lesson as its control.
 *
 * Requires local Postgres + Redis, like every DB-backed test here.
 */

const STUDENT_AUTH = "auth:assess-student";
const STRANGER_AUTH = "auth:assess-stranger";
const STUDENT_EMAIL = "assess.student@hive.test";
const STRANGER_EMAIL = "assess.stranger@hive.test";
const INSTRUCTOR_EMAIL = "assess.instructor@hive.test";
const SLUG = "assessment-session-course";

const ALL_EMAILS = `'${STUDENT_EMAIL}', '${STRANGER_EMAIL}', '${INSTRUCTOR_EMAIL}'`;

let db: ReturnType<typeof getDb>;
let app: Hono;
const tokens: Record<string, string> = {};
let studentId: number;
let courseId: number;
let assessmentLessonId: number;
let quizLessonId: number;
let questionId: number;
let otherQuestionId: number;

const sql = async (statement: string) => {
	const result = await db.execute(statement);
	return result.rows as any[];
};
const one = async (statement: string) => (await sql(statement))[0];

/** @info - Children before parents, matched on markers so this is safe as the
 *  first act of a run as well as the last, and the community (RESTRICT) goes
 *  before the users who own it. */
const cleanup = async () => {
	const courseIds = `(SELECT id FROM courses WHERE slug = '${SLUG}')`;
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
	await sql(`DELETE FROM modules WHERE course_id IN ${courseIds}`);
	await sql(`DELETE FROM courses WHERE slug = '${SLUG}'`);
	await sql(
		`DELETE FROM communities WHERE slug = 'assessment-session-community'`,
	);
	await sql(`DELETE FROM users WHERE lower(email) IN (${ALL_EMAILS})`);
};

const call = (
	path: string,
	as: string,
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

const bodyOf = async (response: Response) => (await response.json()) as any;
const sessionOf = async (response: Response) => (await bodyOf(response)).data.data;

/** @info - Move a session's clock so the deadline logic can be exercised without
 *  waiting for it: the server derives the state from `started_at`, so backdating
 *  the row is the honest way to age an attempt. */
const backdateSession = (minutes: number) =>
	sql(
		`UPDATE assessment_sessions SET started_at = now() - interval '${minutes} minutes' WHERE user_id = ${studentId} AND lesson_id = ${assessmentLessonId}`,
	);

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

	studentId = await mkUser("Stu", STUDENT_EMAIL);
	const strangerId = await mkUser("Stranger", STRANGER_EMAIL);
	const instructorId = await mkUser("Inst", INSTRUCTOR_EMAIL);
	for (const [userId, role] of [
		[studentId, "student"],
		[strangerId, "student"],
		[instructorId, "instructor"],
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
					`INSERT INTO communities (name, slug, owner_id) VALUES ('Assessment Sessions', 'assessment-session-community', ${instructorId}) RETURNING id`,
				)
			).id;

	courseId = (
		await one(
			`INSERT INTO courses (instructor_id, community_id, title, slug, status)\n\t\t\t VALUES (${instructorId}, ${communityId}, 'Assessment Sessions', '${SLUG}', 'published') RETURNING id`,
		)
	).id as number;
	const moduleId = (
		await one(
			`INSERT INTO modules (course_id, title) VALUES (${courseId}, 'Module') RETURNING id`,
		)
	).id;

	/* @info - Two assessment lessons' worth of shape: one assessment (30 minute
	 * limit) and one quiz as the control. */
	assessmentLessonId = (
		await one(
			`INSERT INTO lessons (module_id, title, type, status, time_limit_minutes) VALUES (${moduleId}, 'Final', 'assessment', 'published', 30) RETURNING id`,
		)
	).id;
	quizLessonId = (
		await one(
			`INSERT INTO lessons (module_id, title, type, status) VALUES (${moduleId}, 'Practice', 'quiz', 'published') RETURNING id`,
		)
	).id;

	questionId = (
		await one(
			`INSERT INTO quiz_questions (lesson_id, type, text, correct_answer, points) VALUES (${assessmentLessonId}, 'multiple', 'Q1', 'B', 1) RETURNING id`,
		)
	).id;
	otherQuestionId = (
		await one(
			`INSERT INTO quiz_questions (lesson_id, type, text, correct_answer, points) VALUES (${assessmentLessonId}, 'multiple', 'Q2', 'C', 1) RETURNING id`,
		)
	).id;
	await sql(
		`INSERT INTO quiz_questions (lesson_id, type, text, correct_answer, points) VALUES (${quizLessonId}, 'multiple', 'Quiz Q', 'A', 1)`,
	);

	/* @info - The student is enrolled; the stranger is not, and is the control for
	 * the enrollment gate. */
	await sql(
		`INSERT INTO enrollments (user_id, course_id, progress_percent) VALUES (${studentId}, ${courseId}, 0)`,
	);

	const cache = CacheService.getInstance();
	for (const [authId, id, email, roles, firstName] of [
		[STUDENT_AUTH, studentId, STUDENT_EMAIL, ["student"], "Stu"],
		[STRANGER_AUTH, strangerId, STRANGER_EMAIL, ["student"], "Stranger"],
	] as const) {
		tokens[authId] = jwt.generateToken(authId);
		await cache.set(authId, { id, email, firstName, roles, isAuthenticated: true });
	}
});

afterAll(async () => {
	const cache = CacheService.getInstance();
	for (const authId of Object.keys(tokens)) await cache.delete(authId);
	await cleanup();
});

describe("the enrollment gate", () => {
	it("session: 403 for a caller with no enrollment", async () => {
		const res = await call(
			`/quiz/lessons/${assessmentLessonId}/assessment/session`,
			STRANGER_AUTH,
		);
		expect(res.status).toBe(403);
	});

	it("start: 403 for a caller with no enrollment, and no session is created", async () => {
		const res = await call(
			`/quiz/lessons/${assessmentLessonId}/assessment/start`,
			STRANGER_AUTH,
			{ method: "POST" },
		);
		expect(res.status).toBe(403);

		const rows = await one(
			`SELECT count(*)::int n FROM assessment_sessions WHERE lesson_id = ${assessmentLessonId}`,
		);
		expect(rows.n).toBe(0);
	});

	it("autosave: 403 for a caller with no enrollment", async () => {
		const res = await call(`/quiz/attempts/autosave`, STRANGER_AUTH, {
			method: "POST",
			body: { lessonId: assessmentLessonId, questionId, selectedAnswer: "B" },
		});
		expect(res.status).toBe(403);
	});
});

describe("POST /quiz/lessons/:lessonId/assessment/start", () => {
	it("opens a session and reports the deadline and the server clock", async () => {
		const res = await call(
			`/quiz/lessons/${assessmentLessonId}/assessment/start`,
			STUDENT_AUTH,
			{ method: "POST" },
		);
		expect(res.status).toBe(200);

		const session = await sessionOf(res);
		expect(session.status).toBe("in_progress");
		expect(session.timeLimitMinutes).toBe(30);
		expect(session.startedAt).toBeTruthy();
		expect(session.serverNow).toBeTruthy();
		expect(
			new Date(session.deadline).getTime() -
				new Date(session.startedAt).getTime(),
		).toBe(30 * 60_000);
		expect(session.answers).toEqual([]);
	});

	it("is idempotent: a second Start returns the same started_at", async () => {
		const first = await sessionOf(
			await call(
				`/quiz/lessons/${assessmentLessonId}/assessment/session`,
				STUDENT_AUTH,
			),
		);
		const second = await sessionOf(
			await call(
				`/quiz/lessons/${assessmentLessonId}/assessment/start`,
				STUDENT_AUTH,
				{ method: "POST" },
			),
		);
		expect(second.startedAt).toBe(first.startedAt);

		const rows = await one(
			`SELECT count(*)::int n FROM assessment_sessions WHERE lesson_id = ${assessmentLessonId}`,
		);
		expect(rows.n).toBe(1);
	});

	it("400s on a lesson that is not an assessment", async () => {
		const res = await call(
			`/quiz/lessons/${quizLessonId}/assessment/start`,
			STUDENT_AUTH,
			{ method: "POST" },
		);
		expect(res.status).toBe(400);
	});
});

describe("POST /quiz/attempts/autosave", () => {
	it("stores an answer without scoring it", async () => {
		const res = await call(`/quiz/attempts/autosave`, STUDENT_AUTH, {
			method: "POST",
			body: { lessonId: assessmentLessonId, questionId, selectedAnswer: "B" },
		});
		expect(res.status).toBe(200);

		const body = await bodyOf(res);
		expect(body.data.data.serverNow).toBeTruthy();
		/* @info - No correctness anywhere in the response: this is the oracle. */
		expect(JSON.stringify(body)).not.toContain("isCorrect");
		expect(JSON.stringify(body)).not.toContain("correctAnswer");
	});

	it("400s for a quiz lesson: quizzes keep their explicit-submit flow", async () => {
		const res = await call(`/quiz/attempts/autosave`, STUDENT_AUTH, {
			method: "POST",
			body: { lessonId: quizLessonId, questionId, selectedAnswer: "A" },
		});
		expect(res.status).toBe(400);
	});

	it("400s once the session has expired past grace", async () => {
		await backdateSession(31);
		const res = await call(`/quiz/attempts/autosave`, STUDENT_AUTH, {
			method: "POST",
			body: { lessonId: assessmentLessonId, questionId, selectedAnswer: "C" },
		});
		expect(res.status).toBe(400);
	});

	it("400s once the session is submitted", async () => {
		await sql(
			`UPDATE assessment_sessions SET submitted_at = now() WHERE user_id = ${studentId} AND lesson_id = ${assessmentLessonId}`,
		);
		const res = await call(`/quiz/attempts/autosave`, STUDENT_AUTH, {
			method: "POST",
			body: { lessonId: assessmentLessonId, questionId, selectedAnswer: "C" },
		});
		expect(res.status).toBe(400);
	});
});

describe("AC18 - the attempts read is not an answer oracle", () => {
	it("withholds isCorrect while the session is open, but still returns the answer", async () => {
		/* @info - A fresh session, an autosaved CORRECT answer, then the read. */
		await sql(
			`DELETE FROM assessment_sessions WHERE user_id = ${studentId} AND lesson_id = ${assessmentLessonId}`,
		);
		await sql(
			`INSERT INTO assessment_sessions (user_id, lesson_id, started_at) VALUES (${studentId}, ${assessmentLessonId}, now())`,
		);
		await call(`/quiz/attempts/autosave`, STUDENT_AUTH, {
			method: "POST",
			body: { lessonId: assessmentLessonId, questionId, selectedAnswer: "B" },
		});

		const res = await call(`/quiz/attempts/${assessmentLessonId}`, STUDENT_AUTH);
		expect(res.status).toBe(200);

		const rows = (await bodyOf(res)).data.data as any[];
		const mine = rows.filter((row) => Number(row.questionId) === questionId);
		expect(mine).toHaveLength(1);
		expect(mine[0].selectedAnswer).toBe("B");
		expect(mine[0].isCorrect).toBeUndefined();

		/* @info - And it appears again once the attempt is finished. Submitted the
		 * real way — through the endpoint — so this also pins that grading writes
		 * `isCorrect` and that a successful submit closes the session. */
		const submit = await call(`/quiz/attempts`, STUDENT_AUTH, {
			method: "POST",
			body: { lessonId: assessmentLessonId, answers: [{ questionId, selectedAnswer: "B" }] },
		});
		expect(submit.status).toBe(200);

		const closed = await one(
			`SELECT submitted_at FROM assessment_sessions WHERE user_id = ${studentId} AND lesson_id = ${assessmentLessonId}`,
		);
		expect(closed.submitted_at).toBeTruthy();

		const after = await call(
			`/quiz/attempts/${assessmentLessonId}`,
			STUDENT_AUTH,
		);
		const finished = ((await bodyOf(after)).data.data as any[]).filter(
			(row) => Number(row.questionId) === questionId,
		);
		expect(finished[0].isCorrect).toBe(true);
	});

	it("grades an expired attempt on read: no background job closes it (D9)", async () => {
		/* @info - Nothing was submitted: the deadline simply passed. The attempt is
		 * graded on whatever was autosaved the first time anyone asks, and the first
		 * ask is this read. */
		await sql(
			`UPDATE assessment_sessions SET submitted_at = NULL, started_at = now() - interval '90 minutes' WHERE user_id = ${studentId} AND lesson_id = ${assessmentLessonId}`,
		);
		await sql(
			`UPDATE quiz_attempts SET is_correct = false WHERE user_id = ${studentId} AND lesson_id = ${assessmentLessonId}`,
		);

		const res = await call(`/quiz/attempts/${assessmentLessonId}`, STUDENT_AUTH);
		expect(res.status).toBe(200);

		const rows = ((await bodyOf(res)).data.data as any[]).filter(
			(row) => Number(row.questionId) === questionId,
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].selectedAnswer).toBe("B");
		expect(rows[0].isCorrect).toBe(true);

		const stored = await one(
			`SELECT is_correct FROM quiz_attempts WHERE user_id = ${studentId} AND lesson_id = ${assessmentLessonId} AND question_id = ${questionId}`,
		);
		expect(stored.is_correct).toBe(true);
	});

	it("quiz lessons still return isCorrect, in every state", async () => {
		await sql(
			`INSERT INTO quiz_attempts (user_id, lesson_id, question_id, selected_answer, is_correct) VALUES (${studentId}, ${quizLessonId}, ${otherQuestionId}, 'A', true)`,
		);
		const res = await call(`/quiz/attempts/${quizLessonId}`, STUDENT_AUTH);
		expect(res.status).toBe(200);
		const rows = (await bodyOf(res)).data.data as any[];
		expect(rows).toHaveLength(1);
		expect(rows[0].isCorrect).toBe(true);
	});
});

describe("AC19 - the paper is unreadable before Start", () => {
	const start = () =>
		call(`/quiz/lessons/${assessmentLessonId}/assessment/start`, STUDENT_AUTH, {
			method: "POST",
		});

	it("403 with no session, 200 with one, and correctAnswer never returned", async () => {
		await sql(
			`DELETE FROM assessment_sessions WHERE user_id = ${studentId} AND lesson_id = ${assessmentLessonId}`,
		);

		const before = await call(
			`/quiz/lessons/${assessmentLessonId}/take`,
			STUDENT_AUTH,
		);
		expect(before.status).toBe(403);

		await start();
		const after = await call(
			`/quiz/lessons/${assessmentLessonId}/take`,
			STUDENT_AUTH,
		);
		expect(after.status).toBe(200);

		const body = await bodyOf(after);
		expect(body.data.data.length).toBeGreaterThan(0);
		expect(JSON.stringify(body)).not.toContain("correctAnswer");
		expect(JSON.stringify(body)).not.toContain('"explanation"');
	});

	it("200 for review once the attempt is submitted", async () => {
		await sql(
			`UPDATE assessment_sessions SET submitted_at = now() WHERE user_id = ${studentId} AND lesson_id = ${assessmentLessonId}`,
		);
		const res = await call(
			`/quiz/lessons/${assessmentLessonId}/take`,
			STUDENT_AUTH,
		);
		expect(res.status).toBe(200);
	});

	it("403 for a non-enrolled caller", async () => {
		const res = await call(
			`/quiz/lessons/${assessmentLessonId}/take`,
			STRANGER_AUTH,
		);
		expect(res.status).toBe(403);
	});

	it("quiz lessons are untouched: readable with no session at all", async () => {
		const res = await call(`/quiz/lessons/${quizLessonId}/take`, STUDENT_AUTH);
		expect(res.status).toBe(200);
	});
});

/**
 * @info - The attempt policy on the submit path, which is the one that writes
 * `quiz_attempts` and therefore the only place the policy needs to live. Grace is
 * the interesting row: the status has already flipped to `expired` (the UI says
 * time is up) while a submit that started before the bell is still accepted.
 */
describe("the submit guard", () => {
	const submit = (as: string) =>
		call(`/quiz/attempts`, as, {
			method: "POST",
			body: {
				lessonId: assessmentLessonId,
				answers: [{ questionId, selectedAnswer: "B" }],
			},
		});

	/** @info - A session in a known state, so each case reads on its own. */
	const sessionIn = async (state: "open" | "late" | "past" | "submitted" | "none") => {
		await sql(
			`DELETE FROM assessment_sessions WHERE user_id = ${studentId} AND lesson_id = ${assessmentLessonId}`,
		);
		if (state === "none") return;
		/* @info - "late" sits 10 seconds past the deadline, which is inside the 30s
		 * grace window; "past" is a minute past it, which is not. */
		const startedAt =
			state === "late"
				? "30 minutes 10 seconds"
				: state === "past"
					? "31 minutes"
					: "0 minutes";
		const sign = state === "open" ? "+" : "-";
		await sql(
			`INSERT INTO assessment_sessions (user_id, lesson_id, started_at, submitted_at) VALUES (${studentId}, ${assessmentLessonId}, now() ${sign} interval '${startedAt}', ${state === "submitted" ? "now()" : "NULL"})`,
		);
	};

	it("accepts while the attempt is open", async () => {
		await sessionIn("open");
		expect((await submit(STUDENT_AUTH)).status).toBe(200);
	});

	it("accepts inside the grace window after the deadline", async () => {
		/* @info - 31 minutes in on a 30 minute limit: the deadline has passed, the
		 * status is `expired`, and the submit is still accepted. */
		await sessionIn("late");
		expect((await submit(STUDENT_AUTH)).status).toBe(200);
	});

	it("rejects past the grace window", async () => {
		await sessionIn("past");
		const res = await submit(STUDENT_AUTH);
		expect(res.status).toBe(400);
		expect((await bodyOf(res)).error.message).toBe(QuizMessages.ATTEMPT_EXPIRED);
	});

	it("rejects a second submit: the attempt is closed by the first", async () => {
		await sessionIn("submitted");
		const res = await submit(STUDENT_AUTH);
		expect(res.status).toBe(400);
		expect((await bodyOf(res)).error.message).toBe(
			QuizMessages.ATTEMPT_SUBMITTED,
		);
	});

	it("rejects a submit with no session at all", async () => {
		await sessionIn("none");
		const res = await submit(STUDENT_AUTH);
		expect(res.status).toBe(400);
		expect((await bodyOf(res)).error.message).toBe(
			QuizMessages.ATTEMPT_NOT_STARTED,
		);
	});

	it("a quiz lesson still submits with no session, as it always has", async () => {
		const res = await call(`/quiz/attempts`, STUDENT_AUTH, {
			method: "POST",
			body: { lessonId: quizLessonId, answers: [{ questionId: otherQuestionId, selectedAnswer: "A" }] },
		});
		expect(res.status).toBe(200);
	});

	it("an expired attempt is still readable for review", async () => {
		await sessionIn("past");
		const res = await call(
			`/quiz/lessons/${assessmentLessonId}/take`,
			STUDENT_AUTH,
		);
		expect(res.status).toBe(200);
	});
});
