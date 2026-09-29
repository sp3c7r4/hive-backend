import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "@/errors";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { AssignmentService } from "@/modules/assessments/submission.service";

/**
 * @info - Assignment authorization. The whole assignments module trusted
 * `requireInstructor` to be enough, so any user holding the instructor role
 * could read any course's submissions, grade any submission on the platform, and
 * rewrite any assignment's settings. `GET /submissions/:submissionId` carried no
 * role guard at all, so any logged-in user could read any submission by id -
 * another student's work, its score and the instructor's written feedback.
 *
 * `requireInstructor` answers "is this person an instructor", never "is this
 * their content" or "is this their own work". The check belongs in the service,
 * where the resource is resolved.
 *
 * Repositories are stubbed and the database is never touched, so this suite runs
 * without Postgres or Redis.
 */

const OWNER = { id: 1, roles: ["instructor"] } as unknown as IAuthData;
const STRANGER = { id: 2, roles: ["instructor"] } as unknown as IAuthData;
const ADMIN = { id: 3, roles: ["instructor", "admin"] } as unknown as IAuthData;
const STUDENT = { id: 4, roles: ["student"] } as unknown as IAuthData;

const ownCourse = { id: 10, instructorId: OWNER.id };
const otherCourse = { id: 20, instructorId: 99 };
const otherModule = { id: 200, courseId: otherCourse.id };
const otherLesson = { id: 2000, moduleId: otherModule.id };
const foreignSubmission = {
	id: 3000,
	userId: 500,
	lessonId: otherLesson.id,
	text: "Someone else's coursework",
	fileUrls: [],
	score: 80,
	feedback: "Good work",
};
const ownSubmission = { ...foreignSubmission, id: 3001, userId: STUDENT.id };

function buildService() {
	const service = AssignmentService.getInstance();
	const submissions = {
		findById: vi.fn(),
		findByUserAndLesson: vi.fn(),
		update: vi.fn(),
	};
	const courses = { findById: vi.fn() };
	const modules = { findById: vi.fn() };
	const lessons = { findById: vi.fn(), update: vi.fn() };
	(service as any).submissions = submissions;
	(service as any).courses = courses;
	(service as any).modules = modules;
	(service as any).lessons = lessons;
	return { service, submissions, courses, modules, lessons };
}

function stubForeignSubmission(f: ReturnType<typeof buildService>) {
	f.courses.findById.mockResolvedValue(otherCourse);
	f.modules.findById.mockResolvedValue(otherModule);
	f.lessons.findById.mockResolvedValue(otherLesson);
	f.submissions.findById.mockResolvedValue(foreignSubmission);
}

/** @info - The rejection has to be the missing guard, never a database error
 *  from an unstubbed query: assert the error type, not merely that it threw. */
const rejectsForbidden = async (call: Promise<unknown>) => {
	const error = await call.then(
		() => null,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(ForbiddenError);
};

describe("instructor-only submission routes", () => {
	let f: ReturnType<typeof buildService>;

	beforeEach(() => {
		f = buildService();
	});

	it("403 when a stranger lists another instructor's course submissions", async () => {
		f.courses.findById.mockResolvedValue(otherCourse);
		await rejectsForbidden(f.service.listByCourse(STRANGER, otherCourse.id));
	});

	it("403 when a student lists a course's submissions", async () => {
		f.courses.findById.mockResolvedValue(otherCourse);
		await rejectsForbidden(f.service.listByCourse(STUDENT, otherCourse.id));
	});

	it("403 when a stranger grades another instructor's submission", async () => {
		stubForeignSubmission(f);
		await rejectsForbidden(
			f.service.grade(STRANGER, foreignSubmission.id, {
				score: 100,
				action: "grade",
			}),
		);
		expect(f.submissions.update).not.toHaveBeenCalled();
	});

	it("403 when a student grades a submission", async () => {
		stubForeignSubmission(f);
		await rejectsForbidden(
			f.service.grade(STUDENT, foreignSubmission.id, {
				score: 100,
				action: "grade",
			}),
		);
		expect(f.submissions.update).not.toHaveBeenCalled();
	});

	it("403 when a stranger rewrites another instructor's assignment settings", async () => {
		f.courses.findById.mockResolvedValue(otherCourse);
		f.modules.findById.mockResolvedValue(otherModule);
		f.lessons.findById.mockResolvedValue(otherLesson);
		await rejectsForbidden(
			f.service.updateAssignmentSettings(STRANGER, otherLesson.id, {
				instructions: "rewritten",
			}),
		);
		expect(f.lessons.update).not.toHaveBeenCalled();
	});

	it("an admin is not rejected", async () => {
		f.courses.findById.mockResolvedValue(otherCourse);
		const error = await f.service.listByCourse(ADMIN, otherCourse.id).then(
			() => null,
			(e: unknown) => e,
		);
		expect(error).not.toBeInstanceOf(ForbiddenError);
		expect(f.courses.findById).toHaveBeenCalledWith(otherCourse.id);
	});
});

describe("GET /submissions/:submissionId — author or owning instructor only", () => {
	let f: ReturnType<typeof buildService>;

	beforeEach(() => {
		f = buildService();
	});

	it("403 when a stranger instructor reads another instructor's submission", async () => {
		stubForeignSubmission(f);
		await rejectsForbidden(f.service.get(STRANGER, foreignSubmission.id));
	});

	it("403 when a student reads another student's submission", async () => {
		stubForeignSubmission(f);
		await rejectsForbidden(f.service.get(STUDENT, foreignSubmission.id));
	});

	it("the submission's own author can read it", async () => {
		f.courses.findById.mockResolvedValue(ownCourse);
		f.modules.findById.mockResolvedValue(otherModule);
		f.lessons.findById.mockResolvedValue(otherLesson);
		f.submissions.findById.mockResolvedValue(ownSubmission);
		await expect(
			f.service.get(STUDENT, ownSubmission.id),
		).resolves.toMatchObject({
			id: ownSubmission.id,
		});
	});

	it("the owning instructor can read it", async () => {
		f.courses.findById.mockResolvedValue(otherCourse);
		f.modules.findById.mockResolvedValue(otherModule);
		f.lessons.findById.mockResolvedValue(otherLesson);
		f.submissions.findById.mockResolvedValue(foreignSubmission);
		await expect(
			f.service.get(
				{ id: 99, roles: ["instructor"] } as unknown as IAuthData,
				foreignSubmission.id,
			),
		).resolves.toMatchObject({ id: foreignSubmission.id });
	});

	it("404 when the submission does not exist", async () => {
		f.submissions.findById.mockResolvedValue(undefined);
		const error = await f.service.get(STUDENT, 999999).then(
			() => null,
			(e: unknown) => e,
		);
		expect(error).not.toBeInstanceOf(ForbiddenError);
		expect(error).toBeInstanceOf(Error);
	});
});
