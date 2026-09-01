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

	it("dashboard: summary + zero-filled enrollment series + active students", async () => {
		/* @info - Bucket keys are computed from "now" (PG Monday week start),
		 * so build the expected periods the same way for date-robustness. */
		const now = new Date();
		const dayKey = (i: number) =>
			new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
		const weekKey = (i: number) => {
			const d = new Date(now.getTime() - i * 7 * 86_400_000);
			const start = new Date(d);
			start.setDate(d.getDate() - ((d.getDay() + 6) % 7));
			return start.toISOString().slice(0, 10);
		};

		/* dashboard() queue:
		 * 1 total sum, 2 this-month sum, 3 balance, 4 sales count,
		 * 5-8 recent activity (enroll, pay, sub, review rows),
		 * 9 daily series rows, 10 weekly series rows, 11 active students */
		mocks.results.push(
			[{ value: 90000 }],
			[{ value: 90000 }],
			[balanceRow],
			[{ value: 4 }],
			[{ id: 1, firstName: "Ada", title: "TS", time: new Date("2026-08-30T10:00:00Z") }],
			[{ id: 2, firstName: "Ben", title: "TS", amount: 100000, time: new Date("2026-08-30T09:00:00Z") }],
			[{ id: 3, firstName: "Cyril", title: "Quiz 1", time: new Date("2026-08-29T10:00:00Z") }],
			[{ id: 4, firstName: "Ada", title: "TS", rating: 5, time: new Date("2026-08-28T10:00:00Z") }],
			[{ period: dayKey(1), total: 2 }],
			[{ period: weekKey(1), total: 1 }, { period: weekKey(2), total: 3 }],
			[{ total: 2 }],
		);
		const service = await loadService();
		const d = await service.dashboard(auth);

		expect(d.summary).toEqual({
			totalEarned: 90000,
			thisMonth: 90000,
			available: 45000,
			withdrawn: 10000,
			sales: 4,
		});
		expect(d.activeStudents7d).toBe(2);
		expect(d.recentActivity).toHaveLength(4);
		expect(d.recentActivity[0]!).toMatchObject({ type: "enrollment" });
		expect(d.recentActivity[1]!.type).toBe("payment");
		expect(d.recentActivity[1]!.text).toContain("paid ₦1,000");
		expect(d.enrollmentSeries.daily).toHaveLength(7);
		expect(d.enrollmentSeries.weekly).toHaveLength(4);
		/* zero-filling: only the matching bucket is non-zero */
		const dailyCounts = d.enrollmentSeries.daily.map((p) => p.count);
		expect(dailyCounts.filter((c) => c > 0).length).toBeGreaterThanOrEqual(1);
		const weeklyCounts = d.enrollmentSeries.weekly.map((p) => p.count);
		expect(weeklyCounts).toEqual(expect.arrayContaining([0, 1, 3]));
	});

	it("dashboard: empty data → zeros and empty series", async () => {
		mocks.results.push([], [], [], [], [], [], [], [], [], [], []);
		const service = await loadService();
		const d = await service.dashboard(auth);
		expect(d.summary.totalEarned).toBe(0);
		expect(d.activeStudents7d).toBe(0);
		expect(d.enrollmentSeries.daily).toHaveLength(7);
		expect(d.enrollmentSeries.weekly).toHaveLength(4);
		expect(d.enrollmentSeries.daily.every((p) => p.count === 0)).toBe(true);
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
