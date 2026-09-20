import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { connectPostgresDB, getDb } from "@/db/postgres.db";
import { CacheService } from "@/services/cache.service";
import { JobNames } from "@/enums";
import { EnrollmentService } from "@/modules/enrollments/enrollment.service";
import { CertificateQueueService } from "@/services/queues/certificate.queue.service";

/**
 * @info - End-to-end certificate eligibility over the real HTTP routes, the
 * real service and real rows — the two failures that prompted this work are
 * reproduced here as regressions (§2A and §2B of the spec).
 *
 * Requires the same local infrastructure as every DB-backed test in this repo
 * (`docker compose -f docker-compose.dev.yml up -d`, `npm run migrate`) plus
 * Redis, because a protected route resolves its session from it.
 *
 * Everything is created in a throwaway course/user and deleted afterwards.
 */

const queue = CertificateQueueService.getInstance();
const addSpy = vi.spyOn(queue, "add").mockResolvedValue({ id: "test-job" } as any);

const AUTH_ID = "auth:cert-eligibility-test";
const EMAIL = "cert.eligibility.test@hive.test";
const INSTRUCTOR_EMAIL = "cert.eligibility.instructor@hive.test";
const SLUG = "cert-eligibility-test-course";

let db: ReturnType<typeof getDb>;
let app: Hono;
let token: string;
let userId: number;
let instructorId: number;
let communityId: number | null = null;
let enrollmentId: number;
let courseId: number;

const published: number[] = [];
const drafts: number[] = [];
let quizLessonId: number;

const sql = async (statement: string) => {
	const result = await db.execute(statement);
	return result.rows as any[];
};

const one = async (statement: string) => (await sql(statement))[0];

/**
 * @info - Deletes the fixture, in dependency order, identified by its unique
 * markers rather than by captured ids — so a run that failed midway (leaving
 * rows behind) cannot poison the next one. Covers both users, since a course
 * references its instructor and deleting the instructor first violates that
 * FK and aborts the rest of the clean-up.
 */
const cleanup = async () => {
	const courseIds = `(SELECT id FROM courses WHERE slug = '${SLUG}')`;
	const moduleIds = `(SELECT id FROM modules WHERE course_id IN ${courseIds})`;
	const lessonIds = `(SELECT id FROM lessons WHERE module_id IN ${moduleIds})`;

	await sql(`DELETE FROM quiz_attempts WHERE lesson_id IN ${lessonIds}`);
	await sql(`DELETE FROM quiz_questions WHERE lesson_id IN ${lessonIds}`);
	await sql(
		`DELETE FROM lesson_progress WHERE enrollment_id IN (SELECT id FROM enrollments WHERE course_id IN ${courseIds})`,
	);
	await sql(`DELETE FROM enrollments WHERE course_id IN ${courseIds}`);
	await sql(`DELETE FROM lessons WHERE module_id IN ${moduleIds}`);
	await sql(`DELETE FROM modules WHERE course_id IN ${courseIds}`);
	await sql(`DELETE FROM courses WHERE slug = '${SLUG}'`);
	await sql(`DELETE FROM users WHERE lower(email) IN ('${EMAIL}', '${INSTRUCTOR_EMAIL}')`);
	await sql(`DELETE FROM communities WHERE slug = 'cert-test-community'`);
};

beforeAll(async () => {
	await connectPostgresDB(() => {});
	db = getDb();

	/* Start from a clean slate in case an earlier run died before its clean-up. */
	await cleanup();

	const { JwtService } = await import("@/services/jwt.service");
	const { testApp } = await import("./setup");
	app = testApp;
	token = JwtService.getInstance().generateToken(AUTH_ID);

	const user = await one(
		`INSERT INTO users (first_name, last_name, email, onboarded) VALUES ('Cert', 'Eligibility', '${EMAIL}', true) RETURNING id`,
	);
	userId = user.id;

	/* The course needs an instructor and a community; both are created or
	 * resolved here so the fixture works on any database state. */
	const instructor = await one(
		`INSERT INTO users (first_name, last_name, email, onboarded) VALUES ('Cert', 'Instructor', '${INSTRUCTOR_EMAIL}', true) RETURNING id`,
	);
	instructorId = instructor.id;
	const existingCommunity = await one(
		`SELECT id FROM communities ORDER BY id LIMIT 1`,
	);
	if (existingCommunity) {
		communityId = existingCommunity.id;
	} else {
		const created = await one(
			`INSERT INTO communities (name, slug, owner_id) VALUES ('Cert Test Community', 'cert-test-community', ${instructorId}) RETURNING id`,
		);
		communityId = created.id;
	}

	const course = await one(
		`INSERT INTO courses (instructor_id, community_id, title, slug, status, offer_certificate, min_completion_percent, min_quiz_score_percent)
		 VALUES (${instructorId}, ${communityId}, 'Cert Eligibility Test', '${SLUG}', 'published', true, 80, 70) RETURNING id`,
	);
	courseId = course.id;
	const module_ = await one(
		`INSERT INTO modules (course_id, title) VALUES (${course.id}, 'Throwaway Module') RETURNING id`,
	);

	/* Two published lessons + four drafts: the drafts must not count. */
	for (let i = 1; i <= 2; i++) {
		const row = await one(
			`INSERT INTO lessons (module_id, title, type, status) VALUES (${module_.id}, 'Published ${i}', 'text', 'published') RETURNING id`,
		);
		published.push(row.id);
	}
	for (let i = 1; i <= 4; i++) {
		const row = await one(
			`INSERT INTO lessons (module_id, title, type, status) VALUES (${module_.id}, 'Draft ${i}', 'text', 'draft') RETURNING id`,
		);
		drafts.push(row.id);
	}

	/* A published quiz lesson with questions, unattempted to begin with. */
	const quiz = await one(
		`INSERT INTO lessons (module_id, title, type, status) VALUES (${module_.id}, 'Eligibility Quiz', 'quiz', 'published') RETURNING id`,
	);
	quizLessonId = quiz.id;
	for (let i = 1; i <= 4; i++) {
		await sql(
			`INSERT INTO quiz_questions (lesson_id, text, correct_answer) VALUES (${quizLessonId}, 'Q${i}', 'A')`,
		);
	}

	const enrollment = await one(
		`INSERT INTO enrollments (user_id, course_id) VALUES (${userId}, ${course.id}) RETURNING id`,
	);
	enrollmentId = enrollment.id;

	/* The session a protected route resolves from Redis. */
	await CacheService.getInstance().set(AUTH_ID, {
		id: userId,
		email: EMAIL,
		firstName: "Cert",
		roles: ["student"],
		isAuthenticated: true,
	});
});

afterAll(async () => {
	addSpy.mockRestore();
	await CacheService.getInstance().delete(AUTH_ID);
	await cleanup();
});

const get = (path: string) =>
	app.request(path, { headers: { Authorization: `Bearer ${token}` } });

const complete = (lessonId: number | undefined) => {
	/* @info - Undefined means the fixture did not build; fail loudly rather than
	 * requesting an invalid path and calling it an eligibility failure. */
	if (lessonId == null) throw new Error("fixture lesson id is missing");
	return app.request(`/api/v1/enrollments/${enrollmentId}/progress/${lessonId}`, {
		method: "PATCH",
		headers: { Authorization: `Bearer ${token}` },
	});
};

describe("certificate eligibility over HTTP", () => {
	it("requires auth on the progress endpoints", async () => {
		const [progress, patch] = await Promise.all([
			app.request(`/api/v1/enrollments/${enrollmentId}/progress`),
			app.request(`/api/v1/enrollments/${enrollmentId}/progress/1`, {
				method: "PATCH",
			}),
		]);
		expect(progress.status).toBe(401);
		expect(patch.status).toBe(401);
	});

	it("returns an eligibility block with the lesson progress", async () => {
		const res = await get(`/api/v1/enrollments/${enrollmentId}/progress`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;

		expect(Array.isArray(body.data.data)).toBe(true);
		expect(body.data.eligibility).toMatchObject({
			eligible: false,
			completionPercent: 0,
			quizScorePercent: null,
		});
		expect(body.data.eligibility.requirements).toHaveLength(2);
		expect(body.data.eligibility.requirements[0]).toMatchObject({
			kind: "completion",
			met: false,
			required: 80,
		});
	});

	it("counts only published lessons, so drafts cannot hold a student below the threshold", async () => {
		for (const id of published) {
			const res = await complete(id);
			expect(res.status).toBe(200);
		}

		const res = await get(`/api/v1/enrollments/${enrollmentId}/progress`);
		const body = (await res.json()) as any;

		/* Three published lessons exist (two text, one quiz); two are complete, so
		 * 2/3 = 67%. Counting the four drafts as well would report 2/6 = 33% and
		 * report a ceiling the student cannot reach. */
		expect(body.data.eligibility.completionPercent).toBe(67);
		expect(body.data.eligibility.requirements[0].met).toBe(false);
	});

	it("§2A — refuses, and names the unattempted quiz instead of reporting 0%", async () => {
		/* Complete the quiz lesson without answering anything: exactly the state
		 * the old code turned into a silent, unexplainable refusal. */
		await complete(quizLessonId);

		const res = await get(`/api/v1/enrollments/${enrollmentId}/progress`);
		const body = (await res.json()) as any;
		const eligibility = body.data.eligibility;

		expect(eligibility.completionPercent).toBe(100);
		expect(eligibility.eligible).toBe(false);
		expect(eligibility.quizScorePercent).toBeNull();

		const quizRequirement = eligibility.requirements.find(
			(r: any) => r.quizLessonId === quizLessonId,
		);
		expect(quizRequirement).toMatchObject({
			kind: "quiz",
			met: false,
			state: "not_attempted",
			actual: null,
			required: 70,
			quizTitle: "Eligibility Quiz",
		});
		expect(eligibility.reason).toContain("has not been attempted");

		/* Nothing was queued for an ineligible student. */
		expect(addSpy).not.toHaveBeenCalled();
	});

	it("queues generation once every requirement is met, and never reports an ineligible pass", async () => {
		/* Pass the quiz: three of four questions correct = 75%, over the 70 mark. */
		await sql(
			`INSERT INTO quiz_attempts (user_id, lesson_id, question_id, is_correct)
			 SELECT ${userId}, ${quizLessonId}, id, (row_number() OVER (ORDER BY id)) <= 3
			 FROM quiz_questions WHERE lesson_id = ${quizLessonId}`,
		);

		addSpy.mockClear();
		const res = await complete(published[0]);
		expect(res.status).toBe(200);

		const body = (await res.json()) as any;
		expect(body.data.eligibility).toMatchObject({
			eligible: true,
			completionPercent: 100,
			quizScorePercent: 75,
		});

		expect(addSpy).toHaveBeenCalledTimes(1);
		expect(addSpy).toHaveBeenCalledWith(
			JobNames.GENERATE_CERTIFICATE,
			expect.objectContaining({
				userId,
				enrollmentId,
				completionPercent: 100,
				quizScorePercent: 75,
				/* Idempotency is per user+course, so a second completion of the
				 * same course can never generate a duplicate certificate. */
				idempotencyKey: `certificate:${courseId}:${userId}`,
			}),
		);
	});

	it("re-enqueues with the identical idempotency key on a repeat completion", async () => {
		addSpy.mockClear();
		await complete(published[1]);
		await complete(published[0]);

		expect(addSpy).toHaveBeenCalledTimes(2);
		const [first, second] = addSpy.mock.calls.map((call: any[]) => call[1]);
		expect(first.idempotencyKey).toBe(`certificate:${courseId}:${userId}`);
		expect(second.idempotencyKey).toBe(first.idempotencyKey);
	});

	it("§2B — the self-issuance route is gone", async () => {
		const res = await app.request("/api/v1/certificates/issue", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
			body: JSON.stringify({
				courseId: 1,
				enrollmentId,
				completionPercent: 100,
				quizScorePercent: 100,
				attendancePercent: 100,
				minCompletion: 0,
				minQuiz: 0,
				minAttendance: 0,
				allowCertificate: true,
			}),
		});
		expect(res.status).toBe(404);
	});
});

describe("certificate eligibility: course without certificates", () => {
	it("reports ineligible with no requirements when the course offers none", async () => {
		await sql(
			`UPDATE courses SET offer_certificate = false WHERE slug = '${SLUG}'`,
		);

		const res = await get(`/api/v1/enrollments/${enrollmentId}/progress`);
		const body = (await res.json()) as any;

		expect(body.data.eligibility).toMatchObject({
			eligible: false,
			requirements: [],
			reason: "This course does not offer certificates.",
		});

		await sql(`UPDATE courses SET offer_certificate = true WHERE slug = '${SLUG}'`);
	});
});

describe("EnrollmentService.evaluateEligibility", () => {
	it("returns null for an enrollment that does not exist", async () => {
		const result = await EnrollmentService.getInstance().evaluateEligibility(
			userId,
			999_999_999,
		);
		expect(result).toBeNull();
	});
});
