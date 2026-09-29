import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestError } from "@/errors";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { QuizMessages } from "@/modules/assessments/quiz.message";
import { QuizService } from "@/modules/assessments/quiz.service";

/**
 * @info - Starting an assessment is idempotent, and that is the whole feature.
 *
 * An assessment may be taken once, so "has this student taken it" has to mean
 * "has a session", never "has quiz_attempts rows" — a student who opened it and
 * walked away has none of the latter. The unique index on
 * `(user_id, lesson_id)` is the rule itself (two concurrent Start presses must
 * not open two sessions); these tests pin the behaviour around it:
 *
 *   - a second Start returns the SAME session and never moves `started_at`
 *     (resuming must not restart the clock);
 *   - a Start on a submitted or expired attempt writes nothing;
 *   - a Start on something that is not an assessment is refused.
 *
 * Repositories are stubbed and no rows are read, as in `quiz-ownership.test.ts`.
 */

const STUDENT = { id: 4, roles: ["student"] } as unknown as IAuthData;

const lessonBase = {
	id: 2000,
	moduleId: 200,
	type: "assessment",
	status: "published",
	timeLimitMinutes: 30,
};
const assessment = { ...lessonBase };
const quizLesson = { ...lessonBase, id: 2001, type: "quiz" };

function buildService() {
	const service = QuizService.getInstance();
	const lessons = { findById: vi.fn() };
	const sessions = {
		findByUserAndLesson: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
	};
	const courses = { findById: vi.fn() };
	const modules = { findById: vi.fn() };
	(service as any).courses = courses;
	(service as any).modules = modules;
	(service as any).lessons = lessons;
	(service as any).sessions = sessions;
	vi.spyOn(service as any, "reindexLesson").mockResolvedValue(undefined);
	/* @info - The resume payload reads attempt rows; stubbed empty so these tests
	 * stay about the session, not about answers (Task 3's suite owns those). */
	vi.spyOn(service as any, "listAttemptsForStudent").mockResolvedValue([]);
	return { service, lessons, sessions, courses, modules };
}

const rejectsBadRequest = async (call: Promise<unknown>, message?: string) => {
	const error = await call.then(
		() => null,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(BadRequestError);
	if (message) expect((error as Error).message).toBe(message);
};

describe("startAssessment", () => {
	let f: ReturnType<typeof buildService>;

	beforeEach(() => {
		f = buildService();
		f.lessons.findById.mockResolvedValue(assessment);
	});

	it("refuses a lesson that is not an assessment", async () => {
		f.lessons.findById.mockResolvedValue(quizLesson);
		await rejectsBadRequest(
			f.service.startAssessment(STUDENT, quizLesson.id),
			QuizMessages.NOT_ASSESSMENT,
		);
		expect(f.sessions.create).not.toHaveBeenCalled();
	});

	it("creates the session when there is none", async () => {
		/* @info - `started_at` is "now", not a literal date: the state is derived from
		 * the real clock, so a fixture pinned to a calendar date would pass or fail
		 * depending on the hour the suite runs. */
		const justNow = new Date();
		f.sessions.findByUserAndLesson.mockResolvedValue(undefined);
		f.sessions.create.mockResolvedValue({
			id: 1,
			userId: STUDENT.id,
			lessonId: assessment.id,
			startedAt: justNow,
			submittedAt: null,
		});

		const result = await f.service.startAssessment(STUDENT, assessment.id);

		expect(f.sessions.create).toHaveBeenCalledTimes(1);
		expect(result.status).toBe("in_progress");
		expect(result.startedAt).toEqual(justNow);
		expect(result.deadline).toEqual(new Date(justNow.getTime() + 30 * 60_000));
	});

	it("returns the existing session and does not move started_at", async () => {
		const startedAt = new Date();
		f.sessions.findByUserAndLesson.mockResolvedValue({
			id: 1,
			userId: STUDENT.id,
			lessonId: assessment.id,
			startedAt,
			submittedAt: null,
		});

		const result = await f.service.startAssessment(STUDENT, assessment.id);

		expect(f.sessions.create).not.toHaveBeenCalled();
		expect(f.sessions.update).not.toHaveBeenCalled();
		expect(result.startedAt).toEqual(startedAt);
		expect(result.status).toBe("in_progress");
	});

	it("writes nothing for a submitted attempt", async () => {
		f.sessions.findByUserAndLesson.mockResolvedValue({
			id: 1,
			userId: STUDENT.id,
			lessonId: assessment.id,
			startedAt: new Date("2026-09-29T09:00:00.000Z"),
			submittedAt: new Date("2026-09-29T09:20:00.000Z"),
		});

		const result = await f.service.startAssessment(STUDENT, assessment.id);

		expect(result.status).toBe("submitted");
		expect(f.sessions.create).not.toHaveBeenCalled();
		expect(f.sessions.update).not.toHaveBeenCalled();
	});

	it("writes nothing for an expired attempt", async () => {
		f.sessions.findByUserAndLesson.mockResolvedValue({
			id: 1,
			userId: STUDENT.id,
			lessonId: assessment.id,
			startedAt: new Date("2020-01-01T09:00:00.000Z"),
			submittedAt: null,
		});

		const result = await f.service.startAssessment(STUDENT, assessment.id);

		expect(result.status).toBe("expired");
		expect(f.sessions.create).not.toHaveBeenCalled();
		expect(f.sessions.update).not.toHaveBeenCalled();
	});

	it("counts a duplicate-key race as the other Start having won", async () => {
		/* @info - The unique index is the rule; the loser of the race must re-read
		 * rather than surface a 500 to a student pressing Start twice. */
		const startedAt = new Date();
		f.sessions.findByUserAndLesson
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce({
				id: 1,
				userId: STUDENT.id,
				lessonId: assessment.id,
				startedAt,
				submittedAt: null,
			});
		f.sessions.create.mockRejectedValue({ code: "23505" } as any);

		const result = await f.service.startAssessment(STUDENT, assessment.id);

		expect(result.startedAt).toEqual(startedAt);
		expect(result.status).toBe("in_progress");
	});
});

describe("getAssessmentSession", () => {
	let f: ReturnType<typeof buildService>;

	beforeEach(() => {
		f = buildService();
		f.lessons.findById.mockResolvedValue(assessment);
	});

	it("refuses a lesson that is not an assessment", async () => {
		f.lessons.findById.mockResolvedValue(quizLesson);
		await rejectsBadRequest(
			f.service.getAssessmentSession(STUDENT, quizLesson.id),
			QuizMessages.NOT_ASSESSMENT,
		);
	});

	it("not_started with no session, and never writes", async () => {
		f.sessions.findByUserAndLesson.mockResolvedValue(undefined);

		const result = await f.service.getAssessmentSession(STUDENT, assessment.id);

		expect(result.status).toBe("not_started");
		expect(result.startedAt).toBeNull();
		expect(result.deadline).toBeNull();
		expect(f.sessions.create).not.toHaveBeenCalled();
	});

	it("reports the deadline and the server clock the countdown is measured from", async () => {
		const startedAt = new Date(Date.now() - 60_000);
		f.sessions.findByUserAndLesson.mockResolvedValue({
			id: 1,
			userId: STUDENT.id,
			lessonId: assessment.id,
			startedAt,
			submittedAt: null,
		});

		const result = await f.service.getAssessmentSession(STUDENT, assessment.id);

		expect(result.deadline).toEqual(
			new Date(startedAt.getTime() + 30 * 60_000),
		);
		expect(result.serverNow).toBeInstanceOf(Date);
		expect(result.timeLimitMinutes).toBe(30);
	});

	it("deadline is null for an untimed assessment", async () => {
		f.lessons.findById.mockResolvedValue({
			...assessment,
			timeLimitMinutes: null,
		});
		f.sessions.findByUserAndLesson.mockResolvedValue({
			id: 1,
			userId: STUDENT.id,
			lessonId: assessment.id,
			startedAt: new Date(Date.now() - 60_000),
			submittedAt: null,
		});

		const result = await f.service.getAssessmentSession(STUDENT, assessment.id);

		expect(result.status).toBe("in_progress");
		expect(result.deadline).toBeNull();
	});
});
