import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "@/errors";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { QuizService } from "@/modules/assessments/quiz.service";

/**
 * @info - Quiz authorization. Every instructor route in the assessments module
 * took a bare course/lesson/question id and trusted `requireInstructor` to be
 * enough, so any user holding the instructor role could read or rewrite another
 * instructor's quiz. The role guard answers "is this person an instructor", not
 * "is this their content" — the ownership check has to live in the service,
 * where the resource is resolved.
 *
 * Repositories are stubbed and the database is never touched, so this suite runs
 * without Postgres or Redis (the HTTP-level companion in
 * `quiz-ownership-api.test.ts` needs both).
 */

const OWNER = { id: 1, roles: ["instructor"] } as unknown as IAuthData;
const STRANGER = { id: 2, roles: ["instructor"] } as unknown as IAuthData;
const ADMIN = { id: 3, roles: ["instructor", "admin"] } as unknown as IAuthData;
const STUDENT = { id: 4, roles: ["student"] } as unknown as IAuthData;

const ownCourse = { id: 10, instructorId: OWNER.id };
const otherCourse = { id: 20, instructorId: 99 };
const otherModule = { id: 200, courseId: otherCourse.id };
const otherLesson = { id: 2000, moduleId: otherModule.id };
const otherQuestion = {
	id: 3000,
	lessonId: otherLesson.id,
	text: "Whose question is this?",
	correctAnswer: "Not yours",
};

function buildService() {
	const service = QuizService.getInstance();
	const courses = { findById: vi.fn() };
	const modules = { findById: vi.fn() };
	const lessons = { findById: vi.fn() };
	const questions = {
		findById: vi.fn(),
		findByLesson: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
		delete: vi.fn(),
	};
	const attempts = { findByUserAndLesson: vi.fn() };
	(service as any).courses = courses;
	(service as any).modules = modules;
	(service as any).lessons = lessons;
	(service as any).questions = questions;
	(service as any).attempts = attempts;
	/* @info - Best-effort Redis-backed re-index on every quiz edit; stubbed so a
	 * missing Redis cannot masquerade as a test failure. */
	vi.spyOn(service as any, "reindexLesson").mockResolvedValue(undefined);
	return { service, courses, modules, lessons, questions, attempts };
}

/** @info - Resolves the standard "stranger's question" fixture through the
 *  lesson → module → course chain the guard has to walk. */
function stubForeignQuestion(f: ReturnType<typeof buildService>) {
	f.courses.findById.mockResolvedValue(otherCourse);
	f.modules.findById.mockResolvedValue(otherModule);
	f.lessons.findById.mockResolvedValue(otherLesson);
	f.questions.findById.mockResolvedValue(otherQuestion);
}

/** @info - A rejection here has to be the missing guard, never a database error
 *  from an unstubbed query: assert on the error type, not merely that it threw. */
const rejectsForbidden = async (call: Promise<unknown>) => {
	const error = await call.then(
		() => null,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(ForbiddenError);
};

const rejectsForAnotherReason = async (call: Promise<unknown>) => {
	const error = await call.then(
		() => null,
		(e: unknown) => e,
	);
	expect(error).not.toBeInstanceOf(ForbiddenError);
};

describe("quiz results — instructor may only read their own course", () => {
	let f: ReturnType<typeof buildService>;

	beforeEach(() => {
		f = buildService();
	});

	it("403 when a stranger reads another instructor's course results", async () => {
		f.courses.findById.mockResolvedValue(otherCourse);
		await rejectsForbidden(f.service.listByCourse(STRANGER, otherCourse.id));
	});

	it("403 when a student reaches a course they do not teach", async () => {
		f.courses.findById.mockResolvedValue(otherCourse);
		await rejectsForbidden(f.service.listByCourse(STUDENT, otherCourse.id));
	});

	it("404 when the course does not exist", async () => {
		f.courses.findById.mockResolvedValue(undefined);
		await rejectsForAnotherReason(f.service.listByCourse(STRANGER, 999));
	});

	it("the owning instructor is not rejected", async () => {
		f.courses.findById.mockResolvedValue(ownCourse);
		await rejectsForAnotherReason(f.service.listByCourse(OWNER, ownCourse.id));
		expect(f.courses.findById).toHaveBeenCalledWith(ownCourse.id);
	});

	it("an admin is not rejected", async () => {
		f.courses.findById.mockResolvedValue(otherCourse);
		await rejectsForAnotherReason(
			f.service.listByCourse(ADMIN, otherCourse.id),
		);
	});
});

describe("quiz builder — instructor may only touch their own questions", () => {
	let f: ReturnType<typeof buildService>;

	beforeEach(() => {
		f = buildService();
	});

	it("403 listing another instructor's lesson questions", async () => {
		f.courses.findById.mockResolvedValue(otherCourse);
		f.modules.findById.mockResolvedValue(otherModule);
		f.lessons.findById.mockResolvedValue(otherLesson);
		await rejectsForbidden(f.service.listQuestions(STRANGER, otherLesson.id));
		expect(f.questions.findByLesson).not.toHaveBeenCalled();
	});

	it("403 creating a question on another instructor's lesson", async () => {
		f.courses.findById.mockResolvedValue(otherCourse);
		f.modules.findById.mockResolvedValue(otherModule);
		f.lessons.findById.mockResolvedValue(otherLesson);
		await rejectsForbidden(
			f.service.createQuestion(STRANGER, {
				lessonId: otherLesson.id,
				text: "injected",
				correctAnswer: "x",
			} as any),
		);
		expect(f.questions.create).not.toHaveBeenCalled();
	});

	it("403 reading another instructor's question", async () => {
		stubForeignQuestion(f);
		await rejectsForbidden(f.service.getQuestion(STRANGER, otherQuestion.id));
	});

	it("403 updating another instructor's question", async () => {
		stubForeignQuestion(f);
		await rejectsForbidden(
			f.service.updateQuestion(STRANGER, otherQuestion.id, {
				text: "rewritten",
			}),
		);
		expect(f.questions.update).not.toHaveBeenCalled();
	});

	it("403 deleting another instructor's question", async () => {
		stubForeignQuestion(f);
		await rejectsForbidden(
			f.service.deleteQuestion(STRANGER, otherQuestion.id),
		);
		expect(f.questions.delete).not.toHaveBeenCalled();
	});

	it("403 when a student reaches the builder", async () => {
		stubForeignQuestion(f);
		await rejectsForbidden(f.service.getQuestion(STUDENT, otherQuestion.id));
	});

	it("the owning instructor can list their own lesson's questions", async () => {
		f.courses.findById.mockResolvedValue(ownCourse);
		f.modules.findById.mockResolvedValue({ id: 100, courseId: ownCourse.id });
		f.lessons.findById.mockResolvedValue({ id: 1000, moduleId: 100 });
		f.questions.findByLesson.mockResolvedValue([otherQuestion]);
		await expect(f.service.listQuestions(OWNER, 1000)).resolves.toHaveLength(1);
	});

	it("the owning instructor can update their own question", async () => {
		f.courses.findById.mockResolvedValue(ownCourse);
		f.modules.findById.mockResolvedValue({ id: 100, courseId: ownCourse.id });
		f.lessons.findById.mockResolvedValue({ id: 1000, moduleId: 100 });
		f.questions.findById.mockResolvedValue({
			...otherQuestion,
			lessonId: 1000,
		});
		f.questions.update.mockResolvedValue({ ...otherQuestion, text: "mine" });
		await expect(
			f.service.updateQuestion(OWNER, otherQuestion.id, { text: "mine" }),
		).resolves.toMatchObject({ text: "mine" });
	});
});
