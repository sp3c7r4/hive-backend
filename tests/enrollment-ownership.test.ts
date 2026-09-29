import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "@/errors";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { EnrollmentService } from "@/modules/enrollments/enrollment.service";

/**
 * @info - An enrollment belongs to the student it enrolls.
 *
 * All three routes that address an enrollment by id were authorized by nothing
 * but a valid token:
 *
 *   GET   /enrollments/:id                      -> EnrollmentService.get(id)
 *   GET   /enrollments/:enrollmentId/progress   -> getLessonProgress(authData, id)
 *   PATCH /enrollments/:enrollmentId/progress/:lessonId -> markLessonComplete
 *
 * `get` took no caller at all, and `getLessonProgress` read the progress rows
 * before doing anything with the caller it was handed. The PATCH is the sharpest
 * of the three: `upsertProgress(enrollmentId, lessonId, _userId)` ignores the user
 * entirely, so any logged-in student could mark lessons complete inside another
 * student's enrollment — which feeds that student's `progressPercent` and, through
 * `_maybeQueueCertificate`, their certificate.
 *
 * Who may read one: the student it enrolls, the person who paid for it
 * (`enrolledById` is the parent on a parent-bought enrollment), and an admin. No
 * screen reads an enrollment by id for anyone else — the learn page resolves its
 * own id from `GET /enrollments`, and instructor views are course-scoped.
 *
 * Repositories are stubbed and the database is never touched, so this suite runs
 * without Postgres or Redis.
 */

const STUDENT = { id: 1, roles: ["student"] } as unknown as IAuthData;
const STRANGER = { id: 2, roles: ["student"] } as unknown as IAuthData;
const PARENT = { id: 3, roles: ["parent"] } as unknown as IAuthData;
const ADMIN = { id: 4, roles: ["instructor", "admin"] } as unknown as IAuthData;

const enrollment = {
	id: 500,
	userId: STUDENT.id,
	courseId: 10,
	enrolledById: null as number | null,
	progressPercent: 0,
};

function buildService() {
	const service = EnrollmentService.getInstance();
	const enrollments = { findById: vi.fn(), findMany: vi.fn() };
	const progress = {
		findByEnrollment: vi.fn(),
		upsertProgress: vi.fn(),
	};
	(service as any).enrollments = enrollments;
	(service as any).progress = progress;
	return { service, enrollments, progress };
}

/** @info - Assert the error TYPE, not merely that something threw: an unstubbed
 *  query raises a plain Error and must not be mistaken for the guard firing. */
const rejectsForbidden = async (call: Promise<unknown>) => {
	const error = await call.then(
		() => null,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(ForbiddenError);
};

describe("GET /enrollments/:id", () => {
	let f: ReturnType<typeof buildService>;

	beforeEach(() => {
		f = buildService();
		f.enrollments.findById.mockResolvedValue(enrollment);
	});

	it("403 when another student reads it", async () => {
		await rejectsForbidden(f.service.get(STRANGER, enrollment.id));
	});

	it("the enrolled student can read it", async () => {
		await expect(f.service.get(STUDENT, enrollment.id)).resolves.toMatchObject({
			id: enrollment.id,
		});
	});

	it("the parent who paid for it can read it", async () => {
		f.enrollments.findById.mockResolvedValue({
			...enrollment,
			enrolledById: PARENT.id,
		});
		await expect(f.service.get(PARENT, enrollment.id)).resolves.toMatchObject({
			id: enrollment.id,
		});
	});

	it("an admin can read it", async () => {
		await expect(f.service.get(ADMIN, enrollment.id)).resolves.toMatchObject({
			id: enrollment.id,
		});
	});

	it("neither the student nor the parent grants access when the id is someone else's", async () => {
		f.enrollments.findById.mockResolvedValue({
			...enrollment,
			enrolledById: 999,
		});
		await rejectsForbidden(f.service.get(PARENT, enrollment.id));
		await rejectsForbidden(f.service.get(STRANGER, enrollment.id));
	});

	it("404 when it does not exist", async () => {
		f.enrollments.findById.mockResolvedValue(undefined);
		const error = await f.service.get(STUDENT, 999999).then(
			() => null,
			(e: unknown) => e,
		);
		expect(error).not.toBeInstanceOf(ForbiddenError);
		expect(error).toBeInstanceOf(Error);
	});
});

describe("GET /enrollments/:enrollmentId/progress", () => {
	let f: ReturnType<typeof buildService>;

	beforeEach(() => {
		f = buildService();
		f.enrollments.findById.mockResolvedValue(enrollment);
		f.progress.findByEnrollment.mockResolvedValue([]);
	});

	it("403 when another student reads the progress, before any row is read", async () => {
		await rejectsForbidden(
			f.service.getLessonProgress(STRANGER, enrollment.id),
		);
		expect(f.progress.findByEnrollment).not.toHaveBeenCalled();
	});

	it("the enrolled student reads their own progress", async () => {
		await expect(
			f.service.getLessonProgress(STUDENT, enrollment.id),
		).resolves.toBeDefined();
		expect(f.progress.findByEnrollment).toHaveBeenCalledWith(enrollment.id);
	});

	it("403 for a student whose id is not the enrollment's", async () => {
		f.enrollments.findById.mockResolvedValue({
			...enrollment,
			userId: 777,
		});
		await rejectsForbidden(
			f.service.getLessonProgress(STRANGER, enrollment.id),
		);
		expect(f.progress.findByEnrollment).not.toHaveBeenCalled();
	});
});

describe("PATCH /enrollments/:enrollmentId/progress/:lessonId", () => {
	let f: ReturnType<typeof buildService>;

	beforeEach(() => {
		f = buildService();
		f.enrollments.findById.mockResolvedValue(enrollment);
		f.progress.upsertProgress.mockResolvedValue({ id: 1 });
	});

	it("403 when another student marks a lesson complete, and nothing is written", async () => {
		await rejectsForbidden(
			f.service.markLessonComplete(STRANGER, enrollment.id, 42),
		);
		expect(f.progress.upsertProgress).not.toHaveBeenCalled();
	});

	it("the enrolled student can mark their own lesson complete", async () => {
		await expect(
			f.service.markLessonComplete(STUDENT, enrollment.id, 42),
		).resolves.toBeDefined();
		expect(f.progress.upsertProgress).toHaveBeenCalledWith(
			enrollment.id,
			42,
			STUDENT.id,
		);
	});

	it("403 when the enrollment is someone else's", async () => {
		f.enrollments.findById.mockResolvedValue({ ...enrollment, userId: 777 });
		await rejectsForbidden(
			f.service.markLessonComplete(STRANGER, enrollment.id, 42),
		);
		expect(f.progress.upsertProgress).not.toHaveBeenCalled();
	});
});
