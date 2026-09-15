import type { Context } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IAuthData } from "@/interfaces/auth/auth.interface";

/**
 * @info - Course CREATE must build its insert from the validated form, not the
 * raw spread. Before this, `POST /courses` re-read the whole FormData and the
 * service spread it into the insert, so any key matching a column name was
 * written (the mass-assignment class the PATCH allowlist closed).
 *
 * The services run against a stubbed db/repository, so no database is touched.
 * The route graph is pre-loaded by setup.ts, hence the resetModules + dynamic
 * import so the db mock below applies to a fresh module graph.
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

await vi.resetModules();
const modules = await (async () => {
	const [{ CourseService }, { CourseController }, schema] = await Promise.all([
		import("@/modules/courses/course.service"),
		import("@/modules/courses/course.controller"),
		import("@/modules/courses/course.schema"),
	]);
	return {
		CourseService,
		CourseController,
		createCourseFormSchema: schema.createCourseFormSchema,
	};
})();

/** @info - `RelationalRepository.create` writes through the injected db client
 * (`insert(table).values(payload).returning()`), so the recorded `.values(...)`
 * argument IS the insert object under test. */
const insertPayload = (): Record<string, unknown> | undefined =>
	mocks.calls.find((c) => c.prop === "values")?.args[0] as
		| Record<string, unknown>
		| undefined;

const insertedAtAll = () => mocks.calls.some((c) => c.prop === "insert");

describe("POST /courses — create allowlist", () => {
	const service = modules.CourseService.getInstance();

	beforeEach(() => {
		mocks.dbResults.length = 0;
		mocks.calls.length = 0;
		/* Two results: the publish-target check resolves the community before the
		 * insert, then the insert itself. The allowlist is what is under test, so a
		 * matching community row is all the check needs to let the write through. */
		mocks.dbResults.push([{ id: 99 }], [{ id: 99 }]);
		/* Slug generation reads the db; the allowlist is what is under test. */
		(service as any)._uniqueCourseSlug = vi
			.fn()
			.mockResolvedValue("safe-course-1");
	});

	it("never writes an undeclared column carried by the payload", async () => {
		await service.createCourse(OWNER, {
			communityId: 10,
			title: "Safe course",
			status: "published",
			instructorId: 999,
			enrollmentCount: 5000,
			averageRating: 5,
			reviewCount: 42,
			deletedAt: new Date("2026-01-01"),
			id: 77,
			slug: "hijacked-slug",
			createdAt: new Date("2020-01-01"),
		} as any);

		const payload = insertPayload()!;
		expect(payload).toMatchObject({
			communityId: 10,
			title: "Safe course",
		});
		for (const column of [
			"status",
			"enrollmentCount",
			"averageRating",
			"reviewCount",
			"deletedAt",
			"id",
			"createdAt",
		]) {
			expect(payload).not.toHaveProperty(column);
		}
		/* instructorId + slug are assigned by the service, never the payload. */
		expect(payload).toHaveProperty("instructorId", 1);
		expect(payload).toHaveProperty("slug", "safe-course-1");
	});

	it("keeps declared fields and coerces the FormData string forms", async () => {
		await service.createCourse(OWNER, {
			communityId: "10",
			title: "Coerced",
			price: "50000",
			isFree: "false",
			allowComments: "false",
			allowDownloads: "true",
			minCompletionPercent: "85",
			coverImageUrl: "uploads/covers/x.png",
		} as any);

		const payload = insertPayload()!;
		expect(payload).toMatchObject({
			communityId: 10,
			price: 50000,
			isFree: false,
			allowComments: false,
			allowDownloads: true,
			minCompletionPercent: 85,
			coverImageUrl: "uploads/covers/x.png",
		});
	});

	it("leaves omitted optionals absent so the model defaults stay authoritative", async () => {
		await service.createCourse(OWNER, {
			communityId: 10,
			title: "Defaults",
		} as any);

		const payload = insertPayload()!;
		for (const column of [
			"allowComments",
			"allowDownloads",
			"status",
			"deletedAt",
		]) {
			expect(payload).not.toHaveProperty(column);
		}
	});

	it("rejects a payload without the required contract fields", async () => {
		await expect(
			service.createCourse(OWNER, { title: "" } as any),
		).rejects.toThrow();
		expect(insertedAtAll()).toBe(false);
	});

	it("schema: strips undeclared keys and keeps coverImageUrl", () => {
		const parsed = modules.createCourseFormSchema.parse({
			communityId: "10",
			title: "T",
			coverImageUrl: "uploads/covers/x.png",
			status: "published",
			instructorId: "999",
		});
		expect(parsed).toHaveProperty("coverImageUrl", "uploads/covers/x.png");
		expect(parsed).not.toHaveProperty("status");
		expect(parsed).not.toHaveProperty("instructorId");
	});
});

describe("course controller create — reads the validated form only", () => {
	const controller = modules.CourseController.getInstance();

	/** @info - The fake context deliberately exposes NO `formData()` and no
	 * raw-body reader: if the controller re-read the request body (the old
	 * behaviour), this test would throw instead of passing. */
	const fakeContext = (form: Record<string, unknown>, uploadedKey?: string) => {
		const json = vi.fn((body: unknown) => ({ body }));
		const c = {
			get: (key: string) =>
				key === "authData"
					? OWNER
					: key === "uploadedFile"
						? uploadedKey
							? { key: uploadedKey }
							: undefined
						: undefined,
			req: {
				valid: (target: string) => (target === "form" ? form : undefined),
			},
			json,
		} as unknown as Context;
		return { c, json };
	};

	it("passes the validated payload plus the uploaded cover key to the service", async () => {
		const spy = vi
			.spyOn((controller as any).service, "createCourse")
			.mockResolvedValue({ id: 5 } as any);
		const { c, json } = fakeContext(
			{ communityId: 10, title: "From form", description: undefined },
			"uploads/covers/y.png",
		);

		await controller.create(c);

		const payload = spy.mock.calls[0]![1] as Record<string, unknown>;
		expect(payload).toMatchObject({
			communityId: 10,
			title: "From form",
			coverImageUrl: "uploads/covers/y.png",
		});
		/* undefined entries are dropped so omitted fields stay omitted */
		expect(payload).not.toHaveProperty("description");
		expect(json).toHaveBeenCalled();
		spy.mockRestore();
	});

	it("omits coverImageUrl when no file was uploaded", async () => {
		const spy = vi
			.spyOn((controller as any).service, "createCourse")
			.mockResolvedValue({ id: 6 } as any);
		const { c } = fakeContext({ communityId: 10, title: "No cover" });

		await controller.create(c);

		const payload = spy.mock.calls[0]![1] as Record<string, unknown>;
		expect(payload).not.toHaveProperty("coverImageUrl");
		spy.mockRestore();
	});
});
