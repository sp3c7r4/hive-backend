import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
	const results: any[] = [];
	const chain: any = {
		select: () => chain,
		from: () => chain,
		innerJoin: () => chain,
		where: () => chain,
		orderBy: () => chain,
		groupBy: () => chain,
		limit: () => ({
			offset: async () => results.shift() ?? [],
			then: async (resolve: any) => resolve(results.shift() ?? []),
		}),
		then: async (resolve: any) => resolve(results.shift() ?? []),
	};
	return { db: chain, results };
});

vi.mock("@/db/postgres.db", () => ({ getDb: () => mocks.db }));

async function loadService() {
	vi.resetModules();
	const { EarningsService } = await import("@/modules/earnings/earnings.service");
	return EarningsService.getInstance();
}

const auth = { id: 5, roles: ["instructor"] } as any;
const balanceRow = { id: 1, instructorId: 5, available: 45000, withdrawn: 10000 };

describe("EarningsService", () => {
	beforeEach(() => {
		mocks.results.length = 0;
	});

	it("summary: aggregates earnings + balance + pending withdrawals", async () => {
		mocks.results.push(
			[{ value: 90000 }], // totalEarned
			[{ value: 4 }], // sales count
			[balanceRow], // balance
			[{ value: 20000 }], // pending withdrawals
		);
		const service = await loadService();
		const s = await service.summary(auth, "30d");
		expect(s).toEqual({
			totalEarned: 90000,
			available: 45000,
			pendingWithdrawal: 20000,
			withdrawn: 10000,
			counts: { sales: 4 },
		});
	});

	it("summary: empty ledger → zeros", async () => {
		mocks.results.push([{ value: null }], [{ value: 0 }], [], [{ value: 0 }]);
		const service = await loadService();
		const s = await service.summary(auth, "all");
		expect(s.totalEarned).toBe(0);
		expect(s.available).toBe(0);
		expect(s.counts.sales).toBe(0);
	});

	it("transactions: paginated ledger (desc)", async () => {
		mocks.results.push(
			[{ id: 3, balanceAfter: 9000 }, { id: 2, balanceAfter: 4000 }],
			[{ value: 2 }],
		);
		const service = await loadService();
		const t = await service.transactions(auth, { page: 1, limit: 30 });
		expect(t.items).toHaveLength(2);
		expect(t.meta).toEqual({ total: 2, page: 1, limit: 30, totalPages: 1 });
	});

	it("courses: groups ledger by course with gross/net", async () => {
		mocks.results.push([
			{ courseId: 3, title: "Car course", sales: 2, gross: 100000, net: 90000 },
		]);
		const service = await loadService();
		const c = await service.courses(auth, "all");
		expect(c[0]).toMatchObject({ courseId: 3, title: "Car course", gross: 100000, net: 90000 });
	});

	it("reconciliation: orphans + stuck pending", async () => {
		mocks.results.push(
			[{ id: 1, reference: "hive-a", status: "success" }],
			[{ id: 2, reference: "hive-b", status: "pending" }],
		);
		const service = await loadService();
		const r = await service.reconciliation();
		expect(r.orphans).toHaveLength(1);
		expect(r.stuckPending).toHaveLength(1);
	});
});
