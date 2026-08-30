import { and, count, desc, eq, gte, inArray, lt, sql, sum } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import { instructorBalance, instructorTransaction } from "@/modules/payment/ledger.model";
import { payments, withdrawals } from "@/modules/payment/payment.model";
import { courses } from "@/modules/courses/course.model";
import type { IAuthData } from "@/interfaces/auth/auth.interface";

const EARNING_CATEGORIES = ["enrollment", "community"] as const;
const OPEN_WITHDRAWAL_STATUSES = ["pending", "processing"] as const;

/** @info - Resolve ?period= to a start timestamp (null = all time). */
const periodStart = (period?: string): Date | null => {
	const days: Record<string, number> = { "7d": 7, "30d": 30, "1y": 365 };
	if (!period || period === "all") return null;
	const d = days[period];
	return d ? new Date(Date.now() - d * 86_400_000) : null;
};

export class EarningsService {
	private static instance: EarningsService;

	static getInstance(): EarningsService {
		if (!this.instance) this.instance = new EarningsService();
		return this.instance;
	}

	private constructor() {}

	summary = async (authData: IAuthData, period?: string) => {
		const db = getDb();
		const userId = Number(authData.id);
		const start = periodStart(period);

		const base = [
			eq(instructorTransaction.instructorId, userId),
			eq(instructorTransaction.type, "credit"),
			inArray(instructorTransaction.category, [...EARNING_CATEGORIES] as any),
		];
		if (start) base.push(gte(instructorTransaction.createdAt, start));

		const [totalRow, salesRow, balanceRow, pendingRow] = await Promise.all([
			db
				.select({ value: sum(instructorTransaction.amount) })
				.from(instructorTransaction)
				.where(and(...base)) as any,
			db
				.select({ value: count() })
				.from(instructorTransaction)
				.where(and(...base)) as any,
			db
				.select()
				.from(instructorBalance)
				.where(eq(instructorBalance.instructorId, userId))
				.limit(1) as any,
			db
				.select({ value: sum(withdrawals.amount) })
				.from(withdrawals)
				.where(
					and(
						eq(withdrawals.instructorId, userId),
						inArray(withdrawals.status, [...OPEN_WITHDRAWAL_STATUSES] as any),
					),
				) as any,
		]);

		const [balance] = balanceRow as any[];
		const [pending] = pendingRow as any[];
		const [total] = totalRow as any[];
		const [sales] = salesRow as any[];

		return {
			totalEarned: Number(total?.value ?? 0),
			available: Number(balance?.available ?? 0),
			pendingWithdrawal: Number(pending?.value ?? 0),
			withdrawn: Number(balance?.withdrawn ?? 0),
			counts: { sales: Number(sales?.value ?? 0) },
		};
	};

	courses = async (authData: IAuthData, period?: string) => {
		const db = getDb();
		const userId = Number(authData.id);
		const start = periodStart(period);

		const base = [
			eq(instructorTransaction.instructorId, userId),
			eq(instructorTransaction.type, "credit"),
			inArray(instructorTransaction.category, [...EARNING_CATEGORIES] as any),
		];
		if (start) base.push(gte(instructorTransaction.createdAt, start));

		const rows = (await db
			.select({
				courseId: courses.id,
				title: courses.title,
				sales: count(),
				gross: sum(payments.amount),
				net: sum(instructorTransaction.amount),
			})
			.from(instructorTransaction)
			.innerJoin(payments, eq(instructorTransaction.paymentId, payments.id))
			.innerJoin(courses, eq(payments.courseId, courses.id))
			.where(and(...base))
			.groupBy(courses.id, courses.title)
			.orderBy(desc(count())) as any);

		return (rows as any[]).map((r) => ({
			courseId: r.courseId,
			title: r.title,
			sales: Number(r.sales ?? 0),
			gross: Number(r.gross ?? 0),
			net: Number(r.net ?? 0),
		}));
	};

	transactions = async (
		authData: IAuthData,
		params?: { page?: number; limit?: number },
	) => {
		const db = getDb();
		const userId = Number(authData.id);
		const page = Math.max(1, Number(params?.page) || 1);
		const limit = Math.max(1, Math.min(Number(params?.limit) || 30, 100));
		const offset = (page - 1) * limit;

		const [rows, [{ value: total }]] = await Promise.all([
			db
				.select()
				.from(instructorTransaction)
				.where(eq(instructorTransaction.instructorId, userId))
				.orderBy(desc(instructorTransaction.createdAt))
				.limit(limit)
				.offset(offset) as any,
			db
				.select({ value: count() })
				.from(instructorTransaction)
				.where(eq(instructorTransaction.instructorId, userId)) as any,
		]);

		return {
			items: rows as any[],
			meta: {
				total: Number(total),
				page,
				limit,
				totalPages: Math.ceil(Number(total) / limit),
			},
		};
	};

	trend = async (authData: IAuthData, period?: string) => {
		const db = getDb();
		const userId = Number(authData.id);
		const start = periodStart(period);

		const month = sql<string>`to_char(date_trunc('month', ${instructorTransaction.createdAt}), 'YYYY-MM')`;
		const base = [
			eq(instructorTransaction.instructorId, userId),
			eq(instructorTransaction.type, "credit"),
			inArray(instructorTransaction.category, [...EARNING_CATEGORIES] as any),
		];
		if (start) base.push(gte(instructorTransaction.createdAt, start));

		const rows = (await db
			.select({ month, net: sum(instructorTransaction.amount) })
			.from(instructorTransaction)
			.where(and(...base))
			.groupBy(month)
			.orderBy(month) as any);

		return (rows as any[]).map((r) => ({
			month: String(r.month),
			net: Number(r.net ?? 0),
		}));
	};

	/** @info - Admin: successful payments with no ledger credit + stuck pending. */
	reconciliation = async () => {
		const db = getDb();
		const dayAgo = new Date(Date.now() - 86_400_000);

		const [orphans, stuck] = await Promise.all([
			db
				.select({
					id: payments.id,
					reference: payments.reference,
					amount: payments.amount,
					status: payments.status,
					createdAt: payments.createdAt,
				})
				.from(payments)
				.where(
					and(
						eq(payments.status, "success"),
						sql`${payments.id} NOT IN (SELECT payment_id FROM instructor_transactions WHERE payment_id IS NOT NULL)`,
					),
				) as any,
			db
				.select({
					id: payments.id,
					reference: payments.reference,
					amount: payments.amount,
					status: payments.status,
					createdAt: payments.createdAt,
				})
				.from(payments)
				.where(
					and(eq(payments.status, "pending"), lt(payments.createdAt, dayAgo)),
				) as any,
		]);

		return { orphans: orphans as any[], stuckPending: stuck as any[] };
	};
}
