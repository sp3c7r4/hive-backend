import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
	const results: any[] = [];
	const records: any[] = [];
	const fixedThenable = {
		then: async (resolve: any) => resolve({ ok: true }),
	};
	const chain: any = {
		select: () => chain,
		from: () => chain,
		innerJoin: () => chain,
		where: () => chain,
		orderBy: () => chain,
		limit: () => ({
			offset: async () => results.shift() ?? [],
			then: async (resolve: any) => resolve(results.shift() ?? []),
		}),
		then: async (resolve: any) => resolve(results.shift() ?? []),
		update: () => ({
			set: (payload: any) => ({
				where: () => {
					records.push({ kind: "update", payload });
					return fixedThenable;
				},
			}),
		}),
	};
	const tx = {
		insert: () => ({
			values: (payload: any) => {
				records.push({ kind: "insert", payload });
				return { onConflictDoUpdate: () => fixedThenable };
			},
		}),
	};
	return { db: chain, tx, results, records };
});

vi.mock("@/db/postgres.db", () => ({ getDb: () => mocks.db }));
vi.mock("@/helpers/db.helper", () => ({
	withTransaction: (fn: any) => fn(mocks.tx),
}));
vi.mock("@/modules/communities/community.repository", () => ({
	CommunityRepository: {
		getInstance: () => ({ findOne: vi.fn(async () => ({ id: 9, averageRating: 0, reviewCount: 0 })), getModel: () => ({ slug: {} }) }),
	},
}));

async function loadService() {
	vi.resetModules();
	const { CommunityRatingService } = await import(
		"@/modules/communities/community-rating.service"
	);
	return CommunityRatingService.getInstance();
}

const auth = { id: 6 } as any;

describe("CommunityRatingService", () => {
	beforeEach(() => {
		mocks.results.length = 0;
		mocks.records.length = 0;
	});

	it("rate: upserts and refreshes the aggregate", async () => {
		// aggregate select (avg, count) then update communities row
		mocks.results.push([{ value: 4.5, total: 2 }]);
		const service = await loadService();
		const r = await service.rate(auth, "typescript-5", 5);

		expect(mocks.records[0]).toMatchObject({ kind: "insert", payload: { communityId: 9, userId: 6, rating: 5 } });
		expect(mocks.records[1]).toMatchObject({ kind: "update", payload: { averageRating: 5, reviewCount: 2 } });
		expect(r).toEqual({ myRating: 5, average: 5, reviewCount: 2 });
	});

	it("rate: rejects ratings outside 1-5", async () => {
		const service = await loadService();
		await expect(service.rate(auth, "typescript-5", 0)).rejects.toThrow("between 1 and 5");
		await expect(service.rate(auth, "typescript-5", 6)).rejects.toThrow("between 1 and 5");
		expect(mocks.records).toHaveLength(0);
	});

	it("list: returns items + aggregate + myRating", async () => {
		mocks.results.push(
			[
				{ id: 1, rating: 5, createdAt: new Date(), firstName: "Amara", lastName: "Obi", avatarUrl: null },
			],
			[{ rating: 5 }],
		);
		const service = await loadService();
		const r = await service.list(auth, "typescript-5");
		expect(r.items).toHaveLength(1);
		expect(r.items[0]).toMatchObject({ rating: 5, user: { name: "Amara Obi", avatarUrl: null } });
		expect(r.myRating).toBe(5);
		expect(r.reviewCount).toBe(0);
	});
});
