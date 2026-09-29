import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { CacheService } from "@/services/cache.service";
import { JwtService } from "@/services/jwt.service";
import { CertificateQueueService } from "@/services/queues/certificate.queue.service";

/**
 * @info - AC20: a half-finished assessment must not count towards a certificate.
 *
 * Autosave writes real `quiz_attempts` rows while the student is still typing, so
 * a gate that counts rows would score a run that is still in progress: it would
 * refuse a student whose assessment is open, or — worse — grade them on a partial
 * attempt. The gate therefore counts an assessment only once its session is
 * `submitted` or `expired` (D25), which is also exactly when D9 grades it.
 *
 * The four cases below are the whole contract:
 *   open + perfect answers        -> invisible: not scored, not a reason to refuse
 *   submitted + perfect answers   -> counts, and the certificate is awarded
 *   expired + perfect answers     -> counts, graded on the autosaved answers (no job)
 *   submitted + wrong answers     -> counts, and now it DOES refuse
 *
 * The last one matters as much as the first: a gate that ignores everything would
 * pass the first three while being useless.
 *
 * Requires local Postgres + Redis, like every DB-backed test here.
 */

const AUTH_ID = "auth:assessment-cert-test";
const EMAIL = "assessment.cert@hive.test";
const INSTRUCTOR_EMAIL = "assessment.cert.instructor@hive.test";
const SLUG = "assessment-cert-course";
const ALL_EMAILS = `'${EMAIL}', '${INSTRUCTOR_EMAIL}'`;

/* @info - The certificate job is queued, not run: the assertion is that the gate
 * decided the student was eligible, not what a worker did afterwards. */
const queue = CertificateQueueService.getInstance();
const addSpy = vi.spyOn(queue, "add").mockResolvedValue({ id: "test-job" } as any);

let db: ReturnType<typeof getDb>;
let app: Hono;
let token: string;
let userId: number;
let enrollmentId: number;
let assessmentLessonId: number;

const sql = async (statement: string) => {
	const result = await db.execute(statement);
	return result.rows as any[];
};
const one = async (statement: string) => (await sql(statement))[0];

/** @info - Children before parents, and the community (RESTRICT) before the users
 *  who own it, so this is safe as the first act of a run and as the last. */
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
	await sql(`DELETE FROM communities WHERE slug = 'assessment-cert-community'`);
	await sql(`DELETE FROM users WHERE lower(email) IN (${ALL_EMAILS})`);
};

const eligibility = async () => {
	const res = await app.request(`/api/v1/enrollments/${enrollmentId}/progress`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	expect(res.status).toBe(200);
	return ((await res.json()) as any).data.eligibility;
};

/** @info - All four questions answered, right or wrong, as autosave would leave
 *  them. `is_correct` is written here rather than left at its default because the
 *  strongest form of the claim is "even a perfect run must not count until closed". */
const answerAll = async (correct: boolean) => {
	for (const question of await sql(
		`SELECT id FROM quiz_questions WHERE lesson_id = ${assessmentLessonId} ORDER BY id`,
	)) {
		await sql(
			`INSERT INTO quiz_attempts (user_id, lesson_id, question_id, selected_answer, is_correct) VALUES (${userId}, ${assessmentLessonId}, ${question.id}, '${correct ? "A" : "ZZZ"}', ${correct})`,
		);
	}
};

const openSession = async (startedMinutesAgo: number) => {
	await sql(
		`DELETE FROM assessment_sessions WHERE user_id = ${userId} AND lesson_id = ${assessmentLessonId}`,
	);
	await sql(
		`INSERT INTO assessment_sessions (user_id, lesson_id, started_at) VALUES (${userId}, ${assessmentLessonId}, now() - interval '${startedMinutesAgo} minutes')`,
	);
};

const closeSession = async (state: "submitted" | "expired") => {
	if (state === "submitted") {
		await sql(
			`UPDATE assessment_sessions SET submitted_at = now() WHERE user_id = ${userId} AND lesson_id = ${assessmentLessonId}`,
		);
		return;
	}
	/* @info - Expired is derived, never stored: past the deadline with no submit. */
	await sql(
		`UPDATE assessment_sessions SET submitted_at = NULL, started_at = now() - interval '90 minutes' WHERE user_id = ${userId} AND lesson_id = ${assessmentLessonId}`,
	);
};

beforeAll(async () => {
	await connectPostgresDB(() => {});
	db = getDb();

	await cleanup();

	const { testApp } = await import("./setup");
	app = testApp;
	token = JwtService.getInstance().generateToken(AUTH_ID);

	const mkUser = async (first: string, email: string) =>
		(
			await one(
				`INSERT INTO users (first_name, last_name, email, onboarded) VALUES ('${first}', 'Tester', '${email}', true) RETURNING id`,
			)
		).id as number;

	userId = await mkUser("Assess", EMAIL);
	const instructorId = await mkUser("Inst", INSTRUCTOR_EMAIL);
	for (const [id, role] of [
		[userId, "student"],
		[instructorId, "instructor"],
	] as const) {
		await sql(`INSERT INTO user_roles (user_id, role) VALUES (${id}, '${role}')`);
	}

	const existing = await one(`SELECT id FROM communities ORDER BY id LIMIT 1`);
	const communityId = existing
		? existing.id
		: (
				await one(
					`INSERT INTO communities (name, slug, owner_id) VALUES ('Assessment Cert', 'assessment-cert-community', ${instructorId}) RETURNING id`,
				)
			).id;

	const course = await one(
		`INSERT INTO courses (instructor_id, community_id, title, slug, status, offer_certificate, min_completion_percent, min_quiz_score_percent)
		 VALUES (${instructorId}, ${communityId}, 'Assessment Cert', '${SLUG}', 'published', true, 100, 70) RETURNING id`,
	);
	const module_ = await one(
		`INSERT INTO modules (course_id, title) VALUES (${course.id}, 'Module') RETURNING id`,
	);

	assessmentLessonId = (
		await one(
			`INSERT INTO lessons (module_id, title, type, status, time_limit_minutes) VALUES (${module_.id}, 'Final Assessment', 'assessment', 'published', 30) RETURNING id`,
		)
	).id;
	for (let i = 1; i <= 4; i++) {
		await sql(
			`INSERT INTO quiz_questions (lesson_id, text, correct_answer) VALUES (${assessmentLessonId}, 'Q${i}', 'A')`,
		);
	}

	enrollmentId = (
		await one(
			`INSERT INTO enrollments (user_id, course_id) VALUES (${userId}, ${course.id}) RETURNING id`,
		)
	).id;

	/* @info - The lesson itself is completed, so the completion threshold cannot be
	 * what decides any test below: the only variable left is the assessment's
	 * session state. */
	await sql(
		`INSERT INTO lesson_progress (enrollment_id, lesson_id, completed) VALUES (${enrollmentId}, ${assessmentLessonId}, true)`,
	);

	await CacheService.getInstance().set(AUTH_ID, {
		id: userId,
		email: EMAIL,
		firstName: "Assess",
		roles: ["student"],
		isAuthenticated: true,
	});
});

afterAll(async () => {
	addSpy.mockRestore();
	await CacheService.getInstance().delete(AUTH_ID);
	await cleanup();
});

describe("AC20 — an assessment and the certificate gate", () => {
	it("ignores an open attempt: perfect answers, mid-run, are not scored and not a refusal", async () => {
		await sql(
			`DELETE FROM quiz_attempts WHERE user_id = ${userId} AND lesson_id = ${assessmentLessonId}`,
		);
		await openSession(5);
		await answerAll(true);

		const result = await eligibility();

		expect(result.completionPercent).toBe(100);
		expect(result.quizScorePercent).toBeNull();
		expect(result.requirements.some((r: any) => r.kind === "quiz")).toBe(false);
		expect(result.eligible).toBe(true);
		/* @info - And reading eligibility never mints anything: only marking a
		 * lesson complete queues a certificate. */
		expect(addSpy).not.toHaveBeenCalled();
	});

	it("counts it once submitted", async () => {
		await closeSession("submitted");
		const result = await eligibility();

		expect(result.quizScorePercent).toBe(100);
		expect(result.eligible).toBe(true);
		const requirement = result.requirements.find((r: any) => r.kind === "quiz");
		expect(requirement).toMatchObject({
			met: true,
			state: "passed",
			actual: 100,
			required: 70,
		});
	});

	it("counts an EXPIRED attempt too, graded on the autosaved answers, with no job", async () => {
		await closeSession("expired");
		const result = await eligibility();

		expect(result.quizScorePercent).toBe(100);
		expect(result.eligible).toBe(true);
	});

	it("and a closed attempt with wrong answers refuses the certificate", async () => {
		/* @info - The control: proves the gate is scoring, not ignoring. Without
		 * this, every assertion above would also hold for a gate that counts
		 * nothing at all. */
		await sql(
			`DELETE FROM quiz_attempts WHERE user_id = ${userId} AND lesson_id = ${assessmentLessonId}`,
		);
		await answerAll(false);
		await closeSession("submitted");

		const result = await eligibility();

		expect(result.completionPercent).toBe(100);
		expect(result.quizScorePercent).toBe(0);
		expect(result.eligible).toBe(false);
		expect(
			result.requirements.find((r: any) => r.kind === "quiz"),
		).toMatchObject({ met: false, state: "failed", actual: 0 });
	});
});
