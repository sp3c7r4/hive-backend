import { beforeEach, describe, expect, it, vi } from "vitest";

/* Mocks — same pattern as messaging-service.test.ts: setup.ts pre-loads the
 * route graph, so we reset modules and load the service fresh per test. */
const mocks = vi.hoisted(() => {
	const dbResults: any[] = [];
	const chain: any = {
		select: () => chain,
		from: () => chain,
		innerJoin: () => chain,
		where: () => chain,
		orderBy: () => chain,
		groupBy: () => chain,
		limit: () => ({
			offset: async () => dbResults.shift() ?? [],
			then: async (resolve: any) => resolve(dbResults.shift() ?? []),
		}),
		then: async (resolve: any) => resolve(dbResults.shift() ?? []),
		update: () => ({
			set: () => ({
				where: () => ({ returning: async () => dbResults.shift() ?? [] }),
			}),
		}),
		delete: () => ({ where: async () => ({}) }),
	};
	const db = chain;
	return { db, dbResults };
});

vi.mock("@/db/postgres.db", () => ({ getDb: () => mocks.db }));
vi.mock("@/modules/communities/community.repository", () => ({
	CommunityRepository: {
		getInstance: () => ({
			findOne: vi.fn(async () => ({ id: 9 })),
			getModel: () => ({}),
		}),
	},
}));
vi.mock("@/services/queues/email.queue.service", () => ({
	EmailQueueService: { getInstance: () => ({}) },
}));
vi.mock("@/modules/messaging/messaging.repository", () => ({
	MessagingRepository: { getInstance: () => ({}) },
}));

async function loadService() {
	vi.resetModules();
	const { CommunityMemberService } = await import(
		"@/modules/communities/community-member.service"
	);
	return CommunityMemberService.getInstance();
}

const auth = { id: 6, roles: ["instructor"] } as any;

describe("CommunityMemberService.listMine", () => {
	beforeEach(() => {
		mocks.dbResults.length = 0;
	});

	it("returns paginated items + meta + counts", async () => {
		mocks.dbResults.push(
			[
				{
					id: 42,
					userId: 7,
					communityId: 9,
					communityName: "Typescript",
					communitySlug: "typescript-5",
					memberRole: "member",
					status: "pending",
					joinedAt: new Date(),
					firstName: "Amara",
					lastName: "Obi",
					email: "amara@hive.ng",
					avatarUrl: null,
				},
			],
			[{ value: 42 }],
			[
				{ status: "active", value: 40 },
				{ status: "pending", value: 2 },
			],
		);

		const service = await loadService();
		const result = await service.listMine(auth, { page: 1, limit: 30 });

		expect(result.items).toHaveLength(1);
		expect(result.items[0]).toMatchObject({
			userId: 7,
			communityName: "Typescript",
			status: "pending",
		});
		expect(result.meta).toEqual({
			total: 42,
			page: 1,
			limit: 30,
			totalPages: 2,
		});
		expect(result.counts).toEqual({ active: 40, pending: 2, blocked: 0 });
	});

	it("handles empty result set", async () => {
		mocks.dbResults.push([], [{ value: 0 }], []);
		const service = await loadService();
		const result = await service.listMine(auth, { search: "nobody" });

		expect(result.items).toHaveLength(0);
		expect(result.meta.total).toBe(0);
		expect(result.counts).toEqual({ active: 0, pending: 0, blocked: 0 });
	});
});

describe("CommunityMemberService owner guards", () => {
	beforeEach(() => {
		mocks.dbResults.length = 0;
	});

	it("updateMember throws 403 when memberRole is owner", async () => {
		mocks.dbResults.push([{ id: 1, memberRole: "owner" }]);
		const service = await loadService();
		await expect(
			service.updateMember(auth, "typescript-5", 5, { status: "blocked" }),
		).rejects.toThrow("The owner cannot be modified");
	});

	it("removeMember throws 403 when memberRole is owner", async () => {
		mocks.dbResults.push([{ id: 1, memberRole: "owner" }]);
		const service = await loadService();
		await expect(service.removeMember(auth, "typescript-5", 5)).rejects.toThrow(
			"The owner cannot be removed",
		);
	});
});

describe("GET /api/v1/members", () => {
	it("returns 401 without auth", async () => {
		vi.resetModules();
		const { createTestApp } = await import("./setup");
		const res = await createTestApp().request("/api/v1/members", {
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(401);
	});
});
