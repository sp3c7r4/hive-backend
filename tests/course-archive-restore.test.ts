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

/** @info - Render a drizzle SQL expression to text (queryChunks → StringChunk
 * `.value` / Column `.name`), so assertions can pin the actual SQL operators. */
function sqlText(expr: unknown): string {
	if (expr == null) return "";
	if (typeof expr === "string") return expr;
	if (typeof expr === "number") return String(expr);
	if (Array.isArray(expr)) return expr.map(sqlText).join("");
	if (typeof expr === "object") {
		const anyExpr = expr as any;
		if (Array.isArray(anyExpr.queryChunks)) {
			return anyExpr.queryChunks.map(sqlText).join("");
		}
		/* drizzle StringChunk holds value as string[] */
		if (Array.isArray(anyExpr.value)) {
			return anyExpr.value.map((v: unknown) => String(v)).join("");
		}
		if (typeof anyExpr.value === "string") return anyExpr.value;
		if (typeof anyExpr.value === "number") return String(anyExpr.value);
		if (typeof anyExpr.name === "string") return anyExpr.name;
	}
	return "";
}

/* Fresh, mock-aware module graph (loaded once). */
await vi.resetModules();
const modules = await (async () => {
	const [
		{ CourseService },
		{ EnrollmentService },
		{ CommunityService },
		{ PaymentController },
		errors,
		courseModel,
		communityModel,
		enrollmentModel,
		paymentModel,
		messagingModel,
	] = await Promise.all([
		import("@/modules/courses/course.service"),
		import("@/modules/enrollments/enrollment.service"),
		import("@/modules/communities/community.service"),
		import("@/modules/payment/payment.controller"),
		import("@/errors"),
		import("@/modules/courses/course.model"),
		import("@/modules/communities/community.model"),
		import("@/modules/enrollments/enrollment.model"),
		import("@/modules/payment/payment.model"),
		import("@/modules/messaging/message.model"),
	]);
	return {
		CourseService,
		EnrollmentService,
		CommunityService,
		PaymentController,
		errors,
		courses: courseModel.courses,
		communities: communityModel.communities,
		enrollmentsModel: enrollmentModel.enrollments,
		payments: paymentModel.payments,
		conversations: messagingModel.conversations,
	};
})();

describe("course update — allowlist + transition matrix", () => {
	const service = modules.CourseService.getInstance();
	const coursesRepo = { findById: vi.fn(), update: vi.fn() };

	beforeEach(() => {
		resetDb();
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
			monthlyPrice: 4900,
			deletedAt: new Date(),
			instructorId: 999,
			communityId: 5,
			id: 123,
		} as any);

		const payload = coursesRepo.update.mock.calls[0]![1];
		expect(payload).toHaveProperty("title", "safe");
		expect(payload).toHaveProperty("monthlyPrice", 4900);
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

	it("looks up soft-deleted rows with includeDeleted (400 not 404)", async () => {
		coursesRepo.findById.mockResolvedValue({
			id: 10,
			instructorId: 1,
			status: "draft",
			deletedAt: new Date(),
		});
		await expect(
			service.updateCourse(OWNER, 10, { status: "published" } as any),
		).rejects.toThrow(modules.errors.BadRequestError);
		expect(coursesRepo.findById).toHaveBeenCalledWith(10, {
			includeDeleted: true,
		});
	});

	it("rejects ANY payload on a soft-deleted course for the owner (400)", async () => {
		coursesRepo.findById.mockResolvedValue({
			id: 10,
			instructorId: 1,
			status: "draft",
			deletedAt: new Date(),
		});
		await expect(
			service.updateCourse(OWNER, 10, { title: "retitled" } as any),
		).rejects.toThrow(modules.errors.BadRequestError);
		expect(coursesRepo.update).not.toHaveBeenCalled();
	});

	it("returns 404 (not 403) for a non-owner on a soft-deleted course", async () => {
		coursesRepo.findById.mockResolvedValue({
			id: 10,
			instructorId: 1,
			status: "draft",
			deletedAt: new Date(),
		});
		await expect(
			service.updateCourse(STRANGER, 10, { title: "retitled" } as any),
		).rejects.toThrow(modules.errors.NotFoundError);
		expect(coursesRepo.update).not.toHaveBeenCalled();
	});

	it.each([
		["draft", "draft"],
		["published", "published"],
		["archived", "archived"],
		["published", "draft"],
		["draft", "archived"],
	] as const)("allows no-op/safe transition %s -> %s", async (from, to) => {
		const course = { id: 10, instructorId: 1, status: from, deletedAt: null };
		coursesRepo.findById.mockResolvedValue(course);
		coursesRepo.update.mockResolvedValue({ ...course, status: to });
		await expect(
			service.updateCourse(OWNER, 10, { status: to } as any),
		).resolves.toBeTruthy();
		expect(coursesRepo.update).toHaveBeenCalledWith(
			10,
			expect.objectContaining({ status: to }),
		);
	});

	it("rejects status transitions for non-owner, non-admin", async () => {
		const course = {
			id: 10,
			instructorId: 1,
			status: "draft",
			deletedAt: null,
		};
		coursesRepo.findById.mockResolvedValue(course);
		await expect(
			service.updateCourse(STRANGER, 10, { status: "published" } as any),
		).rejects.toThrow(modules.errors.ForbiddenError);
		expect(coursesRepo.update).not.toHaveBeenCalled();
	});

	it("unarchive writes only the status field (no community-count side effect)", async () => {
		const course = {
			id: 10,
			instructorId: 1,
			status: "archived",
			deletedAt: null,
		};
		coursesRepo.findById.mockResolvedValue(course);
		coursesRepo.update.mockResolvedValue({ ...course, status: "draft" });
		await service.updateCourse(OWNER, 10, { status: "draft" } as any);
		expect(coursesRepo.update).toHaveBeenCalledTimes(1);
		expect(coursesRepo.update).toHaveBeenCalledWith(10, { status: "draft" });
		expect(mocks.calls.some((c) => c.prop === "update")).toBe(false);
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
		/* courseCount is INCREMENTED here: restore's set-value SQL must read
		 * `course_count + 1` (GREATEST(... - 1, 0) belongs to deleteCourse's
		 * decrement), so a regression to a decrement fails this assertion. */
		const communityUpdate = mocks.calls.find(
			(c) => c.prop === "update" && c.args[0] === modules.communities,
		);
		expect(communityUpdate).toBeTruthy();
		const setCall = mocks.calls.find(
			(c) => c.prop === "set" && c.args[0] && "courseCount" in c.args[0],
		);
		expect(setCall).toBeTruthy();
		const restoreCountSql = sqlText(setCall!.args[0].courseCount);
		expect(restoreCountSql).toContain("+ 1");
		expect(restoreCountSql).not.toContain("- 1");
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

	it("blocks enrollment for a draft course (no prior payment)", async () => {
		mocks.dbResults.push(
			[
				{
					title: "x",
					communityId: null,
					price: 0,
					status: "draft",
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
		expect(result).not.toHaveProperty("description");
		expect(result).not.toHaveProperty("price");
		expect(result).not.toHaveProperty("status");
		expect(result).not.toHaveProperty("communityName");
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

	it("enrolled student sees an archived course in full", async () => {
		mocks.dbResults.push(
			[
				{
					id: 10,
					instructorId: 1,
					status: "archived",
					communityId: null,
					title: "Archived",
					description: "full text",
					coverImageUrl: null,
				},
			],
			[{ id: 7 }],
			[{ firstName: "Ada", lastName: "L", avatarUrl: null }],
		);
		const result: any = await service.getCourse(10, STRANGER);
		expect(result.access).toBe("full");
		expect(result.description).toBe("full text");
	});

	it("stranger gets an empty module list for a draft course", async () => {
		mocks.dbResults.push([{ id: 10, instructorId: 1, status: "draft" }], []);
		const result: any = await service.listModules(10, STRANGER);
		expect(result).toEqual([]);
	});

	it("stranger gets an empty lesson list for an archived course", async () => {
		mocks.dbResults.push(
			[{ courseId: 10 }],
			[{ id: 10, instructorId: 1, status: "archived" }],
			[],
		);
		const result: any = await service.listLessons(5, STRANGER);
		expect(result).toEqual([]);
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

	it("payment guard joins course-origin payments (community_id AND course_id)", async () => {
		mocks.dbResults.push([{ value: 0 }], [{ value: 2 }]);
		await expect(service.delete(5, true, OWNER)).rejects.toThrow(
			modules.errors.BadRequestError,
		);

		const fromPaymentsIdx = mocks.calls.findIndex(
			(c) => c.prop === "from" && c.args[0] === modules.payments,
		);
		expect(fromPaymentsIdx).toBeGreaterThanOrEqual(0);
		const whereCall = mocks.calls
			.slice(fromPaymentsIdx)
			.find((c) => c.prop === "where");
		expect(whereCall).toBeTruthy();
		/* Walk the where-expression object graph for column names (drizzle
		 * columns expose `.name`). `table` (and `config`) hold BACK-REFERENCES
		 * to the whole table, so walking them would enumerate every column of
		 * both tables and make this assertion vacuous — skip them. */
		const collectNames = (obj: unknown, seen = new WeakSet()): string[] => {
			if (!obj || typeof obj !== "object") return [];
			if (seen.has(obj)) return [];
			seen.add(obj);
			const out: string[] = [];
			if (typeof (obj as any).name === "string") out.push((obj as any).name);
			for (const [key, v] of Object.entries(obj)) {
				if (key === "table" || key === "config") continue;
				out.push(...collectNames(v, seen));
			}
			return out;
		};
		const names = [...new Set(collectNames(whereCall!.args[0]))].join("|");
		expect(names).toContain("community_id");
		expect(names).toContain("course_id");
	});

	it("deletes courses then the community when only failed payments remain", async () => {
		mocks.dbResults.push([{ value: 0 }], [{ value: 0 }]);
		await expect(service.delete(5, true, OWNER)).resolves.toBeUndefined();

		const deleteCalls = mocks.calls.filter((c) => c.prop === "delete");
		expect(deleteCalls.length).toBe(3);
		expect(deleteCalls[0]!.args[0]).toBe(modules.courses);
		/* The community chat goes with the community — no dangling conversation. */
		expect(deleteCalls[1]!.args[0]).toBe(modules.conversations);
		expect(deleteCalls[2]!.args[0]).toBe(modules.communities);
	});
});

describe("checkout gate (payment initialize)", () => {
	const controller = modules.PaymentController.getInstance();

	const makeContext = () =>
		({
			get: (key: string) => (key === "authData" ? STRANGER : undefined),
			req: {
				json: async () => ({
					type: "enrollment",
					courseId: 10,
					amount: 500000,
				}),
			},
		}) as any;

	beforeEach(() => resetDb());

	it.each(["archived", "draft"] as const)(
		"blocks checkout on a %s course",
		async (status) => {
			mocks.dbResults.push(
				[{ id: 2, email: "s@x.com" }],
				[{ role: "student" }],
				[{ price: 500000, status, deletedAt: null }],
			);
			await expect(controller.initialize(makeContext())).rejects.toThrow(
				modules.errors.BadRequestError,
			);
		},
	);

	it("blocks checkout on a soft-deleted course", async () => {
		mocks.dbResults.push(
			[{ id: 2, email: "s@x.com" }],
			[{ role: "student" }],
			[{ price: 500000, status: "published", deletedAt: new Date() }],
		);
		await expect(controller.initialize(makeContext())).rejects.toThrow(
			modules.errors.BadRequestError,
		);
	});
});
