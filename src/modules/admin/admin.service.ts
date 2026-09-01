import { and, count, desc, eq, gte, sql, sum } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import { users } from "@/modules/user/user.model";
import { communities } from "@/modules/communities/community.model";
import { courses } from "@/modules/courses/course.model";
import { payments, withdrawals } from "@/modules/payment/payment.model";
import { enrollments } from "@/modules/enrollments/enrollment.model";

/** @info - One round trip for the admin dashboard: platform counts,
 * money stats (revenue / fees / pending withdrawals), the withdrawal
 * action queue, monthly revenue series, and recent platform activity. */
export class AdminDashboardService {
	private static instance: AdminDashboardService;

	static getInstance(): AdminDashboardService {
		if (!this.instance) this.instance = new AdminDashboardService();
		return this.instance;
	}

	private constructor() {}

	dashboard = async () => {
		const db = getDb();

		const monthExpr = sql<string>`to_char(date_trunc('month', ${payments.createdAt}), 'YYYY-MM')`;

		const monthStart = new Date();
		monthStart.setDate(1);
		monthStart.setHours(0, 0, 0, 0);

		const [
			userCount,
			communityCount,
			courseCount,
			revenueRow,
			monthRow,
			feesRow,
			pendingRow,
			withdrawalsQueue,
			seriesRows,
			userRows,
			payRows,
			enrollRows,
			commRows,
		] = await Promise.all([
			db.select({ total: count() }).from(users) as any,
			db.select({ total: count() }).from(communities) as any,
			db.select({ total: count() }).from(courses) as any,
			db
				.select({ value: sum(payments.amount) })
				.from(payments)
				.where(eq(payments.status, "success" as any)) as any,
			db
				.select({ value: sum(payments.amount) })
				.from(payments)
				.where(and(eq(payments.status, "success" as any), gte(payments.createdAt, monthStart))) as any,
			db
				.select({ value: sum(payments.platformFee) })
				.from(payments)
				.where(eq(payments.status, "success" as any)) as any,
			db
				.select({ value: sum(withdrawals.amount) })
				.from(withdrawals)
				.where(sql`${withdrawals.status} in ('pending', 'processing')`) as any,
			db
				.select({
					id: withdrawals.id,
					amount: withdrawals.amount,
					bankName: withdrawals.bankName,
					accountNumber: withdrawals.accountNumber,
					requestedAt: withdrawals.requestedAt,
					instructorName: users.firstName,
				})
				.from(withdrawals)
				.innerJoin(users, eq(users.id, withdrawals.instructorId))
				.where(sql`${withdrawals.status} in ('pending', 'processing')`)
				.orderBy(desc(withdrawals.requestedAt))
				.limit(10) as any,
			db
				.select({
					period: monthExpr,
					total: sum(payments.amount),
				})
				.from(payments)
				.where(and(
					eq(payments.status, "success" as any),
					gte(payments.createdAt, new Date(monthStart.getFullYear(), monthStart.getMonth() - 5, 1)),
				))
				.groupBy(monthExpr)
				.orderBy(monthExpr) as any,
			db
				.select({ email: users.email, time: users.createdAt })
				.from(users)
				.orderBy(desc(users.createdAt))
				.limit(10) as any,
			db
				.select({ id: payments.id, email: users.email, title: courses.title, amount: payments.amount, time: payments.createdAt })
				.from(payments)
				.innerJoin(users, eq(users.id, payments.payerId))
				.innerJoin(courses, eq(courses.id, payments.courseId))
				.where(eq(payments.status, "success" as any))
				.orderBy(desc(payments.createdAt))
				.limit(10) as any,
			db
				.select({ id: enrollments.id, email: users.email, title: courses.title, time: enrollments.createdAt })
				.from(enrollments)
				.innerJoin(users, eq(users.id, enrollments.userId))
				.innerJoin(courses, eq(courses.id, enrollments.courseId))
				.orderBy(desc(enrollments.createdAt))
				.limit(10) as any,
			db
				.select({ id: communities.id, name: communities.name, time: communities.createdAt })
				.from(communities)
				.orderBy(desc(communities.createdAt))
				.limit(10) as any,
		]);

		/* Monthly revenue series — last 6 months, zero-filled */
		const seriesMap = new Map((seriesRows as any[]).map((r) => [r.period, Number(r.total ?? 0)]));
		const revenueSeries: { period: string; total: number }[] = [];
		for (let i = 5; i >= 0; i--) {
			const d = new Date(monthStart.getFullYear(), monthStart.getMonth() - i, 1);
			const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
			revenueSeries.push({ period: key, total: seriesMap.get(key) ?? 0 });
		}

		/* Recent platform activity */
		const naira = (kobo: number) => `₦${Math.round(kobo / 100).toLocaleString("en-US")}`;
		const userFeed = (userRows as any[]).map((r) => ({
			type: "user",
			text: `${r.email ?? "Someone"} joined Hive`,
			time: r.time,
		}));
		const payFeed = (payRows as any[]).map((r) => ({
			type: "payment",
			text: `${r.email ?? "A student"} paid ${naira(r.amount ?? 0)} for ${r.title ?? "a course"}`,
			time: r.time,
		}));
		const enrollFeed = (enrollRows as any[]).map((r) => ({
			type: "enrollment",
			text: `${r.email ?? "A student"} enrolled in ${r.title ?? "a course"}`,
			time: r.time,
		}));
		const commFeed = (commRows as any[]).map((r) => ({
			type: "community",
			text: `${r.name ?? "A community"} was created`,
			time: r.time,
		}));
		const recentActivity = [...userFeed, ...payFeed, ...enrollFeed, ...commFeed]
			.filter((r) => r.time)
			.sort((a, b) => new Date(b.time!).getTime() - new Date(a.time!).getTime())
			.slice(0, 10)
			.map((r, i) => ({ id: i, type: r.type, text: r.text, time: r.time!.toISOString() }));

		return {
			stats: {
				totalUsers: Number(userCount?.[0]?.total ?? 0),
				totalCommunities: Number(communityCount?.[0]?.total ?? 0),
				totalCourses: Number(courseCount?.[0]?.total ?? 0),
				totalRevenue: Number(revenueRow?.[0]?.value ?? 0),
				thisMonthRevenue: Number(monthRow?.[0]?.value ?? 0),
				platformFees: Number(feesRow?.[0]?.value ?? 0),
				pendingWithdrawals: Number(pendingRow?.[0]?.value ?? 0),
			},
			withdrawalsQueue: (withdrawalsQueue as any[]).map((w) => ({
				id: w.id,
				instructorName: `${w.instructorName ?? ""}`.trim() || "Instructor",
				amount: w.amount,
				bankName: w.bankName,
				accountNumber: w.accountNumber,
				requestedAt: w.requestedAt,
			})),
			revenueSeries,
			recentActivity,
		};
	};
}
