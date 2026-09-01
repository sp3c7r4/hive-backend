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
		limit: () => chain,
		then: async (resolve: any) => resolve(results.shift() ?? []),
	};
	return { db: chain, results };
});

vi.mock("@/db/postgres.db", () => ({ getDb: () => mocks.db }));

async function loadService() {
	vi.resetModules();
	const { AdminDashboardService } = await import("@/modules/admin/admin.service");
	return AdminDashboardService.getInstance();
}

const wdRow = {
	id: 9,
	amount: 200000,
	bankName: "GTBank",
	accountNumber: "0123456789",
	requestedAt: new Date("2026-08-31T08:00:00Z"),
	instructorName: "Sarafa",
};

describe("AdminDashboardService", () => {
	beforeEach(() => {
		mocks.results.length = 0;
	});

	it("dashboard: counts, money stats, queue, series + activity", async () => {
		/* queue order:
		 * 1 users count, 2 communities count, 3 courses count,
		 * 4 revenue sum, 5 month sum, 6 fees sum, 7 pending withdrawals sum,
		 * 8 withdrawals queue rows, 9 revenue series rows,
		 * 10 user feed, 11 payment feed, 12 enrollment feed, 13 community feed */
		mocks.results.push(
			[{ total: 3 }],
			[{ total: 1 }],
			[{ total: 9 }],
			[{ value: 3609000 }],
			[{ value: 3609000 }],
			[{ value: 360900 }],
			[{ value: 200000 }],
			[wdRow],
			[{ period: "2026-08", total: 3609000 }],
			[{ email: "new@user.com", time: new Date("2026-08-31T10:00:00Z") }],
			[{ id: 1, email: "stu@t.com", title: "Bread", amount: 4000000, time: new Date("2026-08-31T09:00:00Z") }],
			[{ id: 1, email: "stu@t.com", title: "TS", time: new Date("2026-08-30T10:00:00Z") }],
			[{ id: 1, name: "AI Engineering", time: new Date("2026-08-29T10:00:00Z") }],
		);
		const service = await loadService();
		const d = await service.dashboard();

		expect(d.stats).toEqual({
			totalUsers: 3,
			totalCommunities: 1,
			totalCourses: 9,
			totalRevenue: 3609000,
			thisMonthRevenue: 3609000,
			platformFees: 360900,
			pendingWithdrawals: 200000,
		});
		expect(d.withdrawalsQueue).toHaveLength(1);
		expect(d.withdrawalsQueue[0]).toMatchObject({
			id: 9,
			instructorName: "Sarafa",
			amount: 200000,
			bankName: "GTBank",
		});
		expect(d.revenueSeries).toHaveLength(6);
		expect(d.revenueSeries.some((s) => s.total === 3609000)).toBe(true);
		expect(d.recentActivity).toHaveLength(4);
		expect(d.recentActivity[0]!.type).toBe("user");
		expect(d.recentActivity[1]!.text).toContain("paid ₦40,000");
	});

	it("dashboard: empty platform → zeros", async () => {
		mocks.results.push([], [], [], [], [], [], [], [], [], [], [], [], []);
		const service = await loadService();
		const d = await service.dashboard();
		expect(d.stats.totalUsers).toBe(0);
		expect(d.stats.totalRevenue).toBe(0);
		expect(d.withdrawalsQueue).toHaveLength(0);
		expect(d.recentActivity).toHaveLength(0);
		expect(d.revenueSeries).toHaveLength(6);
	});
});
