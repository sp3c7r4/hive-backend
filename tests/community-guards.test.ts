import { describe, it, expect, vi, beforeEach } from "vitest";

/* Route graphs are pre-loaded by setup.ts; load guards fresh per test. */
const mocks = vi.hoisted(() => {
	const dbResults: any[] = [];
	const chain: any = {
		select: () => chain,
		from: () => chain,
		where: () => chain,
		limit: () => ({
			then: async (resolve: any) => resolve(dbResults.shift() ?? []),
		}),
		then: async (resolve: any) => resolve(dbResults.shift() ?? []),
	};
	return { chain, dbResults };
});

vi.mock("@/db/postgres.db", () => ({ getDb: () => mocks.chain }));
const sendErrorResponse = vi.fn(async (_c: unknown, body: any, status: number) => ({ body, status }));
vi.mock("@/helpers/response/send-response", () => ({ sendErrorResponse: (c: unknown, b: any, s: number) => sendErrorResponse(c, b, s) }));

async function loadGuards() {
	vi.resetModules();
	return import("@/middlewares/auth/community-guards");
}

const mkCtx = () => {
	const store: Record<string, any> = { authData: { id: 6 } };
	return {
		get: (k: string) => store[k],
		set: (k: string, v: any) => (store[k] = v),
		req: { param: () => "typescript-5" },
	} as any;
};

const next = vi.fn(async () => {});

describe("community-guards — blocked status enforcement", () => {
	beforeEach(() => {
		mocks.dbResults.length = 0;
		sendErrorResponse.mockClear();
		next.mockClear();
	});

	it("requireCommunityMember → 403 when member is blocked", async () => {
		mocks.dbResults.push([{ id: 9, slug: "typescript-5" }], [{ id: 1, status: "blocked" }]);
		const { requireCommunityMember } = await loadGuards();
		const c = mkCtx();
		const res = await requireCommunityMember(c, next);
		expect(res).toBeDefined();
		expect(res!.status).toBe(403);
		expect(next).not.toHaveBeenCalled();
	});

	it("requireCommunityMember → passes when member is active", async () => {
		mocks.dbResults.push([{ id: 9, slug: "typescript-5" }], [{ id: 1, status: "active" }]);
		const { requireCommunityMember } = await loadGuards();
		const c = mkCtx();
		const res = await requireCommunityMember(c, async () => {});
		expect(res).toBeUndefined();
		expect(c.get("communityMember").status).toBe("active");
	});

	it("requireCommunityAdmin → 403 when admin is blocked", async () => {
		mocks.dbResults.push(
			[{ id: 9, slug: "typescript-5" }],
			[{ id: 1, memberRole: "admin", status: "blocked" }],
		);
		const { requireCommunityAdmin } = await loadGuards();
		const c = mkCtx();
		const res = await requireCommunityAdmin(c, next);
		expect(res).toBeDefined();
		expect(res!.status).toBe(403);
		expect(next).not.toHaveBeenCalled();
	});

	it("requireCommunityAdmin → passes for active admin", async () => {
		mocks.dbResults.push(
			[{ id: 9, slug: "typescript-5" }],
			[{ id: 1, memberRole: "admin", status: "active" }],
		);
		const { requireCommunityAdmin } = await loadGuards();
		const c = mkCtx();
		const res = await requireCommunityAdmin(c, async () => {});
		expect(res).toBeUndefined();
		expect(c.get("communityMember").memberRole).toBe("admin");
	});
});
