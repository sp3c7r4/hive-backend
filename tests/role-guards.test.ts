import { Hono } from "hono";
import { beforeAll, describe, expect, it, vi } from "vitest";
/* Type-only imports are erased at runtime — they never load the real
 * module registry, so they cannot defeat the vi.mock calls below. */
import type { requireInstructor as RequireInstructorFn } from "@/middlewares/auth/guards";
import type { JwtService as JwtSvc } from "@/services/jwt.service";

/**
 * @info - Instructor role-guard tests (#1). /instructor/* surfaces must
 * return 403 for authenticated users who do not hold the instructor role
 * (user_roles), and pass through for holders.
 *
 * The setup file (tests/setup.ts) loads the real router graph before this
 * file's mocks register, so modules are imported dynamically AFTER
 * vi.resetModules(). postgres.db AND cache.service are mocked so the
 * guards' user_roles lookup and validateToken's session read run with no
 * live Postgres/Redis (the local test DB has no schema and a real Redis
 * client with maxRetriesPerRequest=null hangs forever when offline).
 */
const { mockRoleRows } = vi.hoisted(() => ({
	mockRoleRows: [] as { role: string }[],
}));

vi.mock("@/db/postgres.db", () => ({
	getDb: () => ({
		select: () => ({
			from: () => ({
				where: () => ({ limit: async () => mockRoleRows }),
			}),
		}),
	}),
}));

vi.mock("@/services/cache.service", () => {
	const SESSION = {
		authId: "auth:roleguard-test-student",
		userType: "student",
		id: 987_654_321,
		email: "roleguard-student@test.local",
		firstName: "Guard",
		lastName: "Student",
		isAuthenticated: true,
		emailVerified: true,
	};
	class FakeCache {
		private static instance: FakeCache;
		readonly redis = {
			get: async () => null,
			set: async () => {},
			del: async () => {},
		};
		static getInstance(): FakeCache {
			if (!FakeCache.instance) FakeCache.instance = new FakeCache();
			return FakeCache.instance;
		}
		get = async <T>(key: string): Promise<T | null> =>
			key === SESSION.authId ? (SESSION as T) : null;
		set = async (): Promise<void> => {};
		delete = async (): Promise<void> => {};
		getRedisClient() {
			return this.redis;
		}
	}
	return { CacheService: FakeCache };
});

const AUTH_ID = "auth:roleguard-test-student";

describe("instructor role guards", () => {
	let requireInstructor: typeof RequireInstructorFn;
	let jwt: JwtSvc;
	let earningsApp: Hono;
	let studentToken: string;

	beforeAll(async () => {
		vi.resetModules();

		const [{ requireInstructor: ri }, jwtMod, earningsRoutes] =
			await Promise.all([
				import("@/middlewares/auth/guards"),
				import("@/services/jwt.service"),
				import("@/modules/earnings/earnings.routes"),
			]);
		requireInstructor = ri;
		jwt = jwtMod.JwtService.getInstance();
		studentToken = jwt.generateToken(AUTH_ID);

		// Mount the real router so route-level guard wiring is exercised
		// through validateToken (mocked session) + requireInstructor
		// (mocked roles). instructorWithdrawalRouter gets the same guard
		// via router-level use("*", jwt.validateToken, requireInstructor);
		// it is not mounted here because importing it pulls the Paystack /
		// BullMQ service chain, which cannot initialize without live Redis.
		earningsApp = new Hono();
		earningsApp.route(
			"/api/v1/instructor/earnings",
			earningsRoutes.earningsRouter,
		);
	});

	it("passes through when the user holds the instructor role", async () => {
		mockRoleRows.length = 0;
		mockRoleRows.push({ role: "instructor" });

		const app = new Hono();
		app.use("*", (c, next) => {
			(c as any).set("authData", { id: 123 });
			return next();
		});
		app.use("*", requireInstructor);
		app.get("/", (c) => c.text("ok"));

		const res = await app.request("/");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("ok");
	});

	it("403 when the user has no instructor role", async () => {
		mockRoleRows.length = 0;

		const app = new Hono();
		app.use("*", (c, next) => {
			(c as any).set("authData", { id: 123 });
			return next();
		});
		app.use("*", requireInstructor);
		app.get("/", (c) => c.text("ok"));

		const res = await app.request("/");
		expect(res.status).toBe(403);
	});

	it("403 on GET /instructor/earnings/dashboard for a student", async () => {
		mockRoleRows.length = 0;
		const res = await earningsApp.request(
			"/api/v1/instructor/earnings/dashboard",
			{ headers: { Authorization: `Bearer ${studentToken}` } },
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: { message?: string } };
		expect(body.error?.message).toContain("Instructor access required");
	});
});
