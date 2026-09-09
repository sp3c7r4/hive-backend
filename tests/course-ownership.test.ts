import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "@/errors";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { CourseService } from "@/modules/courses/course.service";

/**
 * @info - Course object-ownership tests (#1 follow-up / Task C4). Every
 * mutation of a course, module or lesson must be rejected with 403 when the
 * caller is not the owning instructor (and not a platform admin). The
 * service is exercised directly with stubbed repositories; the real DB is
 * never touched.
 */

const OWNER = { id: 1, roles: ["instructor"] } as unknown as IAuthData;
const STRANGER = { id: 2, roles: ["instructor"] } as unknown as IAuthData;
const ADMIN = { id: 3, roles: ["instructor", "admin"] } as unknown as IAuthData;

const ownCourse = { id: 10, instructorId: 1 };
const otherCourse = { id: 20, instructorId: 99 };
const modOf = (course: { id: number }) => ({ id: 100, courseId: course.id });
const lessonOf = (mod: { id: number }) => ({
	id: 1000,
	moduleId: mod.id,
	status: "draft",
});

function buildService() {
	const service = CourseService.getInstance();
	const coursesRepo = {
		findById: vi.fn(),
		update: vi.fn(),
		softDelete: vi.fn(),
		create: vi.fn(),
	};
	const modulesRepo = {
		findById: vi.fn(),
		update: vi.fn(),
		softDelete: vi.fn(),
		create: vi.fn(),
	};
	const lessonsRepo = {
		findById: vi.fn(),
		update: vi.fn(),
		softDelete: vi.fn(),
		create: vi.fn(),
	};
	(service as any).coursesRepo = coursesRepo;
	(service as any).modulesRepo = modulesRepo;
	(service as any).lessonsRepo = lessonsRepo;
	return { service, coursesRepo, modulesRepo, lessonsRepo };
}

describe("course ownership — update/delete course", () => {
	let f: ReturnType<typeof buildService>;

	beforeEach(() => {
		f = buildService();
	});

	it("403 when a stranger updates another instructor's course", async () => {
		f.coursesRepo.findById.mockResolvedValue(otherCourse);
		await expect(
			f.service.updateCourse(STRANGER, otherCourse.id, { title: "x" }),
		).rejects.toThrow(ForbiddenError);
		expect(f.coursesRepo.update).not.toHaveBeenCalled();
	});

	it("403 when a stranger deletes another instructor's course", async () => {
		f.coursesRepo.findById.mockResolvedValue(otherCourse);
		await expect(
			f.service.deleteCourse(STRANGER, otherCourse.id),
		).rejects.toThrow(ForbiddenError);
		expect(f.coursesRepo.softDelete).not.toHaveBeenCalled();
	});

	it("404 when the course does not exist", async () => {
		f.coursesRepo.findById.mockResolvedValue(undefined);
		await expect(f.service.deleteCourse(STRANGER, 999)).rejects.toThrowError(
			/not found/i,
		);
		expect(f.coursesRepo.softDelete).not.toHaveBeenCalled();
	});
});

describe("course ownership — modules", () => {
	let f: ReturnType<typeof buildService>;

	beforeEach(() => {
		f = buildService();
	});

	it("403 when a stranger creates a module on another instructor's course", async () => {
		f.coursesRepo.findById.mockResolvedValue(otherCourse);
		await expect(
			f.service.createModule(STRANGER, otherCourse.id, { title: "M" } as any),
		).rejects.toThrow(ForbiddenError);
		expect(f.modulesRepo.create).not.toHaveBeenCalled();
	});

	it("owner can create a module on their own course", async () => {
		f.coursesRepo.findById.mockResolvedValue(ownCourse);
		f.modulesRepo.create.mockResolvedValue({
			id: 100,
			courseId: 10,
			title: "M",
		});
		const mod = await f.service.createModule(OWNER, ownCourse.id, {
			title: "M",
		} as any);
		expect(mod.id).toBe(100);
		expect(f.modulesRepo.create).toHaveBeenCalledWith(
			expect.objectContaining({ courseId: 10, title: "M" }),
		);
	});

	it("platform admin can create a module on another instructor's course", async () => {
		f.coursesRepo.findById.mockResolvedValue(otherCourse);
		f.modulesRepo.create.mockResolvedValue({
			id: 101,
			courseId: 20,
			title: "M",
		});
		const mod = await f.service.createModule(ADMIN, otherCourse.id, {
			title: "M",
		} as any);
		expect(mod.id).toBe(101);
	});

	it("403 when a stranger updates a module in another instructor's course", async () => {
		f.modulesRepo.findById.mockResolvedValue(modOf(otherCourse));
		f.coursesRepo.findById.mockResolvedValue(otherCourse);
		await expect(
			f.service.updateModule(STRANGER, modOf(otherCourse).id, {
				title: "x",
			} as any),
		).rejects.toThrow(ForbiddenError);
		expect(f.modulesRepo.update).not.toHaveBeenCalled();
	});

	it("owner can update a module in their own course", async () => {
		const mod = modOf(ownCourse);
		f.modulesRepo.findById.mockResolvedValue(mod);
		f.coursesRepo.findById.mockResolvedValue(ownCourse);
		f.modulesRepo.update.mockResolvedValue({ ...mod, title: "new" });
		const updated = await f.service.updateModule(OWNER, mod.id, {
			title: "new",
		} as any);
		expect(updated.title).toBe("new");
		expect(f.modulesRepo.update).toHaveBeenCalledWith(mod.id, { title: "new" });
	});

	it("403 when a stranger deletes a module in another instructor's course", async () => {
		const mod = modOf(otherCourse);
		f.modulesRepo.findById.mockResolvedValue(mod);
		f.coursesRepo.findById.mockResolvedValue(otherCourse);
		await expect(f.service.deleteModule(STRANGER, mod.id)).rejects.toThrow(
			ForbiddenError,
		);
		expect(f.modulesRepo.softDelete).not.toHaveBeenCalled();
	});

	it("owner can delete a module in their own course", async () => {
		const mod = modOf(ownCourse);
		f.modulesRepo.findById.mockResolvedValue(mod);
		f.coursesRepo.findById.mockResolvedValue(ownCourse);
		f.modulesRepo.softDelete.mockResolvedValue(mod);
		await expect(
			f.service.deleteModule(OWNER, mod.id),
		).resolves.toBeUndefined();
		expect(f.modulesRepo.softDelete).toHaveBeenCalledWith(mod.id);
	});
});

describe("course ownership — lessons", () => {
	let f: ReturnType<typeof buildService>;

	beforeEach(() => {
		f = buildService();
	});

	it("403 when a stranger creates a lesson in another instructor's module", async () => {
		const mod = modOf(otherCourse);
		f.modulesRepo.findById.mockResolvedValue(mod);
		f.coursesRepo.findById.mockResolvedValue(otherCourse);
		await expect(
			f.service.createLesson(STRANGER, mod.id, { title: "L" } as any),
		).rejects.toThrow(ForbiddenError);
		expect(f.lessonsRepo.create).not.toHaveBeenCalled();
	});

	it("owner can create a lesson in their own module", async () => {
		const mod = modOf(ownCourse);
		f.modulesRepo.findById.mockResolvedValue(mod);
		f.coursesRepo.findById.mockResolvedValue(ownCourse);
		f.lessonsRepo.create.mockResolvedValue({
			id: 1000,
			moduleId: mod.id,
			title: "L",
		});
		const lesson = await f.service.createLesson(OWNER, mod.id, {
			title: "L",
		} as any);
		expect(lesson.id).toBe(1000);
		expect(f.lessonsRepo.create).toHaveBeenCalledWith(
			expect.objectContaining({ moduleId: mod.id, title: "L" }),
		);
	});

	it("403 when a stranger updates a lesson in another instructor's course", async () => {
		const mod = modOf(otherCourse);
		const lesson = lessonOf(mod);
		f.modulesRepo.findById.mockResolvedValue(mod);
		f.coursesRepo.findById.mockResolvedValue(otherCourse);
		const lessonRows = [lesson];
		const spyGetDb = vi
			.spyOn(await import("@/db/postgres.db"), "getDb")
			.mockReturnValue({
				select: () => ({
					from: () => ({
						where: () => ({ limit: async () => lessonRows }),
					}),
				}),
			} as any);
		await expect(
			f.service.updateLesson(STRANGER, lesson.id, { title: "x" } as any),
		).rejects.toThrow(ForbiddenError);
		expect(f.lessonsRepo.update).not.toHaveBeenCalled();
		spyGetDb.mockRestore();
	});

	it("403 when a stranger deletes a lesson in another instructor's course", async () => {
		const mod = modOf(otherCourse);
		const lesson = lessonOf(mod);
		f.lessonsRepo.findById.mockResolvedValue(lesson);
		f.modulesRepo.findById.mockResolvedValue(mod);
		f.coursesRepo.findById.mockResolvedValue(otherCourse);
		await expect(f.service.deleteLesson(STRANGER, lesson.id)).rejects.toThrow(
			ForbiddenError,
		);
		expect(f.lessonsRepo.softDelete).not.toHaveBeenCalled();
	});

	it("owner can delete a lesson in their own course", async () => {
		const mod = modOf(ownCourse);
		const lesson = lessonOf(mod);
		f.lessonsRepo.findById.mockResolvedValue(lesson);
		f.modulesRepo.findById.mockResolvedValue(mod);
		f.coursesRepo.findById.mockResolvedValue(ownCourse);
		f.lessonsRepo.softDelete.mockResolvedValue(lesson);
		await expect(
			f.service.deleteLesson(OWNER, lesson.id),
		).resolves.toBeUndefined();
		expect(f.lessonsRepo.softDelete).toHaveBeenCalledWith(lesson.id);
	});

	it("403 when a stranger generates a meeting for another instructor's lesson", async () => {
		const mod = modOf(otherCourse);
		const lesson = lessonOf(mod);
		f.lessonsRepo.findById.mockResolvedValue(lesson);
		f.modulesRepo.findById.mockResolvedValue(mod);
		f.coursesRepo.findById.mockResolvedValue(otherCourse);
		await expect(
			f.service.generateMeeting(STRANGER, lesson.id, {
				provider: "google",
				summary: "s",
				startTime: "2026-09-10T10:00:00Z",
				endTime: "2026-09-10T11:00:00Z",
			} as any),
		).rejects.toThrow(ForbiddenError);
		expect(f.lessonsRepo.update).not.toHaveBeenCalled();
	});
});
