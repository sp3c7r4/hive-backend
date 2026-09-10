import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IAuthData } from "@/interfaces/auth/auth.interface";

/**
 * @info - Course Archive/Restore + Retirement Guards (backend). Exercises the
 * services directly with stubbed repositories and a stubbed `getDb`, so the
 * real database is never touched. Covers the status transition matrix, the
 * update allowlist, restore semantics, the enroll/checkout gates, the course
 * read gate, and community permanent-delete guards.
 *
 * The route graph is pre-loaded by setup.ts (which binds the real `getDb`).
 * We therefore `vi.resetModules()` once and dynamically import the services
 * so the `@/db/postgres.db` mock below applies to a fresh module graph.
 */

const mocks = vi.hoisted(() => {
	const dbResults: any[] = [];
	const calls: { prop: string | symbol; args: any[] }[] = [];
	const target: any = {
		then: (resolve: any) => resolve(dbResults.shift()),
	};
	const proxy = new Proxy(target, {
		get(t, prop) {
			if (prop === "then" || prop === "transaction") return t[prop];
			return (...args: any[]) => {
				calls.push({ prop, args });
				return proxy;
			};
		},
	});
	target.transaction = (fn: any) => fn(proxy);
	return { dbResults, calls, chain: proxy };
});

vi.mock("@/db/postgres.db", () => ({ getDb: () => mocks.chain }));

const OWNER = {
	id: 1,
	roles: ["instructor"],
	email: "o@x.com",
} as unknown as IAuthData;
const STRANGER = {
	id: 2,
	roles: ["student"],
	email: "s@x.com",
} as unknown as IAuthData;

function resetDb() {
	mocks.dbResults.length = 0;
	mocks.calls.length = 0;
}

/* Fresh, mock-aware module graph (loaded once). */
await vi.resetModules();
const modules = await (async () => {
	const [
		{ CourseService },
		{ EnrollmentService },
		{ CommunityService },
		errors,
		courseModel,
		communityModel,
		enrollmentModel,
	] = await Promise.all([
		import("@/modules/courses/course.service"),
		import("@/modules/enrollments/enrollment.service"),
		import("@/modules/communities/community.service"),
		import("@/errors"),
		import("@/modules/courses/course.model"),
		import("@/modules/communities/community.model"),
		import("@/modules/enrollments/enrollment.model"),
	]);
	return {
		CourseService,
		EnrollmentService,
		CommunityService,
		errors,
		courses: courseModel.courses,
		communities: communityModel.communities,
		enrollmentsModel: enrollmentModel.enrollments,
	};
})();

describe("course update — allowlist + transition matrix", () => {
	const service = modules.CourseService.getInstance();
	const coursesRepo = { findById: vi.fn(), update: vi.fn() };

	beforeEach(() => {
		coursesRepo.findById.mockReset();
		coursesRepo.update.mockReset();
		(service as any).coursesRepo = coursesRepo;
	});

	it("strips deletedAt / instructorId / communityId / id from the update", async () => {
		const course = {
			id: 10,
			instructorId: 1,
			status: "draft",
			deletedAt: null,
		};
		coursesRepo.findById.mockResolvedValue(course);
		coursesRepo.update.mockResolvedValue({ ...course, title: "safe" });
		await service.updateCourse(OWNER, 10, {
			title: "safe",
			deletedAt: new Date(),
			instructorId: 999,
			communityId: 5,
			id: 123,
		} as any);

		const payload = coursesRepo.update.mock.calls[0]![1];
		expect(payload).toHaveProperty("title", "safe");
		expect(payload).not.toHaveProperty("deletedAt");
		expect(payload).not.toHaveProperty("instructorId");
		expect(payload).not.toHaveProperty("communityId");
		expect(payload).not.toHaveProperty("id");
	});

	it("rejects archived -> published (must unarchive first)", async () => {
		const course = {
			id: 10,
			instructorId: 1,
			status: "archived",
			deletedAt: null,
		};
		coursesRepo.findById.mockResolvedValue(course);
		await expect(
			service.updateCourse(OWNER, 10, { status: "published" } as any),
		).rejects.toThrow(modules.errors.BadRequestError);
		expect(coursesRepo.update).not.toHaveBeenCalled();
	});

	it("allows archived -> draft (unarchive)", async () => {
		const course = {
			id: 10,
			instructorId: 1,
			status: "archived",
			deletedAt: null,
		};
		coursesRepo.findById.mockResolvedValue(course);
		coursesRepo.update.mockResolvedValue({ ...course, status: "draft" });
		await expect(
			service.updateCourse(OWNER, 10, { status: "draft" } as any),
		).resolves.toBeTruthy();
		expect(coursesRepo.update).toHaveBeenCalledWith(
			10,
			expect.objectContaining({ status: "draft" }),
		);
	});

	it("allows published -> archived (retire)", async () => {
		const course = {
			id: 10,
			instructorId: 1,
			status: "published",
			deletedAt: null,
		};
		coursesRepo.findById.mockResolvedValue(course);
		coursesRepo.update.mockResolvedValue({ ...course, status: "archived" });
		await expect(
			service.updateCourse(OWNER, 10, { status: "archived" } as any),
		).resolves.toBeTruthy();
	});

	it("allows draft -> published", async () => {
		const course = {
			id: 10,
			instructorId: 1,
			status: "draft",
			deletedAt: null,
		};
		coursesRepo.findById.mockResolvedValue(course);
		coursesRepo.update.mockResolvedValue({ ...course, status: "published" });
		await expect(
			service.updateCourse(OWNER, 10, { status: "published" } as any),
		).resolves.toBeTruthy();
	});

	it("rejects status change while the course is soft-deleted", async () => {
		const course = {
			id: 10,
			instructorId: 1,
			status: "draft",
			deletedAt: new Date(),
		};
		coursesRepo.findById.mockResolvedValue(course);
		await expect(
			service.updateCourse(OWNER, 10, { status: "published" } as any),
		).rejects.toThrow(modules.errors.BadRequestError);
		expect(coursesRepo.update).not.toHaveBeenCalled();
	});
});

describe("course restore", () => {
	const service = modules.CourseService.getInstance();
	const coursesRepo = { findById: vi.fn(), update: vi.fn() };

	beforeEach(() => {
		resetDb();
		coursesRepo.findById.mockReset();
		coursesRepo.update.mockReset();
		(service as any).coursesRepo = coursesRepo;
	});

	it("restores to draft, clears deletedAt, and re-increments communityCount", async () => {
		const deleted = {
			id: 10,
			instructorId: 1,
			communityId: 5,
			status: "published",
			deletedAt: new Date(),
			coverImageUrl: null,
		};
		coursesRepo.findById.mockResolvedValue(deleted);
		coursesRepo.update.mockResolvedValue({
			...deleted,
			deletedAt: null,
			status: "draft",
		});

		const restored: any = await service.restoreCourse(OWNER, 10);

		expect(coursesRepo.findById).toHaveBeenCalledWith(10, {
			includeDeleted: true,
		});
		expect(coursesRepo.update).toHaveBeenCalledWith(
			10,
			expect.objectContaining({ deletedAt: null, status: "draft" }),
			{ includeDeleted: true },
		);
		expect(restored).toMatchObject({ status: "draft", deletedAt: null });
		expect(mocks.calls.some((c) => c.prop === "update")).toBe(true);
	});

	it("rejects restore for a non-owner", async () => {
		const deleted = {
			id: 10,
			instructorId: 1,
			communityId: 5,
			status: "published",
			deletedAt: new Date(),
		};
		coursesRepo.findById.mockResolvedValue(deleted);
		await expect(service.restoreCourse(STRANGER, 10)).rejects.toThrow(
			modules.errors.ForbiddenError,
		);
		expect(coursesRepo.update).not.toHaveBeenCalled();
	});
});

describe("enrollment gate", () => {
	const service = modules.EnrollmentService.getInstance();
	const enrollments = { findOne: vi.fn(), create: vi.fn() };

	beforeEach(() => {
		resetDb();
		enrollments.findOne.mockReset().mockResolvedValue(undefined);
		enrollments.create
			.mockReset()
			.mockResolvedValue({ id: 1, userId: 2, courseId: 10 });
		(service as any).enrollments = {
			...enrollments,
			getModel: () => ({
				userId: modules.enrollmentsModel.userId,
				courseId: modules.enrollmentsModel.courseId,
			}),
		};
		(service as any).emailQueue = { add: vi.fn() };
	});

	it("blocks enrollment for an archived course (no prior payment)", async () => {
		mocks.dbResults.push(
			[
				{
					title: "x",
					communityId: null,
					price: 0,
					status: "archived",
					deletedAt: null,
				},
			],
			[],
		);
		await expect(service.enroll(STRANGER, 10)).rejects.toThrow(
			modules.errors.BadRequestError,
		);
		expect(enrollments.create).not.toHaveBeenCalled();
	});

	it("blocks enrollment for a soft-deleted course", async () => {
		mocks.dbResults.push(
			[
				{
					title: "x",
					communityId: null,
					price: 0,
					status: "published",
					deletedAt: new Date(),
				},
			],
			[],
		);
		await expect(service.enroll(STRANGER, 10)).rejects.toThrow(
			modules.errors.BadRequestError,
		);
		expect(enrollments.create).not.toHaveBeenCalled();
	});

	it("admits a paid-but-unseated student via the success-payment grace path", async () => {
		mocks.dbResults.push(
			[
				{
					title: "x",
					communityId: null,
					price: 0,
					status: "archived",
					deletedAt: null,
				},
			],
			[{ id: 99 }],
		);
		await expect(service.enroll(STRANGER, 10)).resolves.toBeTruthy();
		expect(enrollments.create).toHaveBeenCalled();
	});
});

describe("course read gate", () => {
	const service = modules.CourseService.getInstance();

	beforeEach(() => resetDb());

	it("stranger on a draft course gets a landing payload (no description)", async () => {
		mocks.dbResults.push(
			[
				{
					id: 10,
					instructorId: 1,
					status: "draft",
					communityId: null,
					title: "Secret",
					description: "full text",
					coverImageUrl: null,
				},
			],
			[],
			[{ firstName: "Ada", lastName: "L", avatarUrl: null }],
		);
		const result: any = await service.getCourse(10, STRANGER);
		expect(result.access).toBe("landing");
		expect(result.description).toBeNull();
	});

	it("published course is full for strangers", async () => {
		mocks.dbResults.push(
			[
				{
					id: 10,
					instructorId: 1,
					status: "published",
					communityId: null,
					title: "Public",
					description: "full text",
					coverImageUrl: null,
				},
			],
			[{ firstName: "Ada", lastName: "L", avatarUrl: null }],
		);
		const result: any = await service.getCourse(10, STRANGER);
		expect(result.access).toBe("full");
		expect(result.description).toBe("full text");
	});

	it("owner sees their draft course in full", async () => {
		mocks.dbResults.push(
			[
				{
					id: 10,
					instructorId: 1,
					status: "draft",
					communityId: null,
					title: "Draft",
					description: "full text",
					coverImageUrl: null,
				},
			],
			[{ firstName: "Ada", lastName: "L", avatarUrl: null }],
		);
		const result: any = await service.getCourse(10, OWNER);
		expect(result.access).toBe("full");
		expect(result.description).toBe("full text");
	});
});

describe("community permanent-delete guards", () => {
	const service = modules.CommunityService.getInstance();

	beforeEach(() => {
		resetDb();
		(service as any).repo = {
			findById: vi
				.fn()
				.mockResolvedValue({ id: 5, ownerId: 1, deletedAt: null }),
		};
	});

	it("blocks when enrollment history exists under the community's courses", async () => {
		mocks.dbResults.push([{ value: 3 }]);
		await expect(service.delete(5, true, OWNER)).rejects.toThrow(
			modules.errors.BadRequestError,
		);
	});

	it("blocks on money-relevant payment statuses (success/pending/refunded)", async () => {
		mocks.dbResults.push([{ value: 0 }], [{ value: 2 }]);
		await expect(service.delete(5, true, OWNER)).rejects.toThrow(
			modules.errors.BadRequestError,
		);
	});

	it("deletes courses then the community when only failed payments remain", async () => {
		mocks.dbResults.push([{ value: 0 }], [{ value: 0 }]);
		await expect(service.delete(5, true, OWNER)).resolves.toBeUndefined();

		const deleteCalls = mocks.calls.filter((c) => c.prop === "delete");
		expect(deleteCalls.length).toBe(2);
		expect(deleteCalls[0]!.args[0]).toBe(modules.courses);
		expect(deleteCalls[1]!.args[0]).toBe(modules.communities);
	});
});
