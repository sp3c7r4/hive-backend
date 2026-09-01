import { and, count, desc, eq, gte, inArray, like, or, sql, sum } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import { withPresignedUrl } from "@/helpers";
import { users } from "@/modules/user/user.model";
import { communities, communityMembers } from "@/modules/communities/community.model";
import { courses } from "@/modules/courses/course.model";
import { payments, withdrawals } from "@/modules/payment/payment.model";
import { enrollments } from "@/modules/enrollments/enrollment.model";
import { certificates } from "@/modules/certificates/certificate.model";
import { reviews } from "@/modules/reviews/review.model";
import { user_roles } from "@/modules/user/user-role.model";
import { throwNotFoundError } from "@/helpers/errors/throw-errors";

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

	/** @info - Admin user detail: profile + real enrollments / payments /
	 * communities / withdrawals / certificates, plus a merged activity feed. */
	userDetail = async (userId: number) => {
		const db = getDb();

		const [user] = (await db
			.select({
				id: users.id,
				firstName: users.firstName,
				lastName: users.lastName,
				email: users.email,
				avatarUrl: users.avatarUrl,
				createdAt: users.createdAt,
				suspendedAt: users.suspendedAt,
				deletedAt: users.deletedAt,
			})
			.from(users)
			.where(eq(users.id, userId))
			.limit(1)) as any[];
		if (!user) throwNotFoundError("User not found.");

		const [roleRows, enrollRows, payRows, commRows, wdRows, certRows] = await Promise.all([
			db.select({ role: user_roles.role }).from(user_roles).where(eq(user_roles.userId, userId)) as any,
			db
				.select({
					courseId: courses.id,
					courseTitle: courses.title,
					progressPercent: enrollments.progressPercent,
					completedAt: enrollments.completedAt,
					createdAt: enrollments.createdAt,
				})
				.from(enrollments)
				.innerJoin(courses, eq(courses.id, enrollments.courseId))
				.where(eq(enrollments.userId, userId))
				.orderBy(desc(enrollments.createdAt)) as any,
			db
				.select({
					amount: payments.amount,
					status: payments.status,
					reference: payments.reference,
					type: payments.type,
					createdAt: payments.createdAt,
					item: sql<string>`coalesce(${courses.title}, ${communities.name})`,
				})
				.from(payments)
				.leftJoin(courses, eq(courses.id, payments.courseId))
				.leftJoin(communities, eq(communities.id, payments.communityId))
				.where(eq(payments.payerId, userId))
				.orderBy(desc(payments.createdAt)) as any,
			db
				.select({
					id: communities.id,
					name: communities.name,
					slug: communities.slug,
					memberRole: communityMembers.memberRole,
					createdAt: communityMembers.createdAt,
				})
				.from(communityMembers)
				.innerJoin(communities, eq(communities.id, communityMembers.communityId))
				.where(eq(communityMembers.userId, userId))
				.orderBy(desc(communityMembers.createdAt)) as any,
			db
				.select({
					amount: withdrawals.amount,
					status: withdrawals.status,
					bankName: withdrawals.bankName,
					requestedAt: withdrawals.requestedAt,
				})
				.from(withdrawals)
				.where(eq(withdrawals.instructorId, userId))
				.orderBy(desc(withdrawals.requestedAt)) as any,
			db
				.select({
					code: certificates.code,
					courseTitle: courses.title,
					issuedAt: certificates.issuedAt,
				})
				.from(certificates)
				.innerJoin(courses, eq(courses.id, certificates.courseId))
				.where(eq(certificates.userId, userId))
				.orderBy(desc(certificates.issuedAt)) as any,
		]);

		const activity: { id: number; type: string; action: string; detail: string; time: string }[] = [];
		let seq = 0;
		for (const e of enrollRows as any[]) {
			activity.push({ id: seq++, type: "enrollment", action: "Enrolled in", detail: e.courseTitle, time: e.createdAt });
		}
		for (const p of payRows as any[]) {
			activity.push({ id: seq++, type: "payment", action: `Paid ${p.status}`, detail: p.item ?? "—", time: p.createdAt });
		}
		for (const w of wdRows as any[]) {
			activity.push({ id: seq++, type: "withdrawal", action: `Withdrawal ${w.status}`, detail: `${w.bankName} (${w.amount})`, time: w.requestedAt });
		}
		for (const c of commRows as any[]) {
			activity.push({ id: seq++, type: "community", action: "Joined community", detail: c.name, time: c.createdAt });
		}
		for (const c of certRows as any[]) {
			activity.push({ id: seq++, type: "certificate", action: "Earned certificate", detail: c.courseTitle, time: c.issuedAt });
		}
		activity.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

		return {
			profile: {
				id: user.id,
				name: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || "—",
				email: user.email,
				avatarUrl: user.avatarUrl
					? withPresignedUrl({ avatarUrl: user.avatarUrl }, "avatarUrl").avatarUrl
					: null,
				roles: (roleRows as any[]).map((r) => r.role),
				joinedAt: user.createdAt,
				status: user.deletedAt ? "deleted" : user.suspendedAt ? "suspended" : "active",
			},
			enrollments: (enrollRows as any[]).map((e) => ({
				courseId: e.courseId,
				courseTitle: e.courseTitle,
				progressPercent: e.progressPercent ?? 0,
				completedAt: e.completedAt,
				enrolledAt: e.createdAt,
			})),
			payments: (payRows as any[]).map((p) => ({
				amount: Number(p.amount ?? 0),
				status: p.status,
				reference: p.reference,
				type: p.type,
				item: p.item ?? null,
				createdAt: p.createdAt,
			})),
			communities: (commRows as any[]).map((c) => ({
				id: c.id,
				name: c.name,
				slug: c.slug,
				memberRole: c.memberRole,
				joinedAt: c.createdAt,
			})),
			activity: activity.slice(0, 20),
		};
	};

	/** @info - Admin payments ledger: every payment with payer name and
	 * the purchased item (course/community title). Kobo amounts, optional
	 * status filter, newest first, 100 cap. */
	payments = async (params?: { status?: string }) => {
		const db = getDb();
		const where = params?.status?.trim()
			? eq(payments.status, params.status as any)
			: undefined;

		const rows = (await db
			.select({
				id: payments.id,
				payerName: sql<string>`concat(${users.firstName}, ' ', ${users.lastName})`,
				payerEmail: users.email,
				amount: payments.amount,
				platformFee: payments.platformFee,
				status: payments.status,
				method: payments.method,
				reference: payments.reference,
				type: payments.type,
				item: sql<string>`coalesce(${courses.title}, ${communities.name})`,
				createdAt: payments.createdAt,
			})
			.from(payments)
			.innerJoin(users, eq(users.id, payments.payerId))
			.leftJoin(courses, eq(courses.id, payments.courseId))
			.leftJoin(communities, eq(communities.id, payments.communityId))
			.where(where)
			.orderBy(desc(payments.createdAt))
			.limit(100)) as any[];

		return rows.map((r) => ({
			id: r.id,
			payerName: r.payerName ?? "Unknown",
			payerEmail: r.payerEmail,
			amount: Number(r.amount ?? 0),
			platformFee: Number(r.platformFee ?? 0),
			status: r.status,
			method: r.method,
			reference: r.reference,
			type: r.type,
			item: r.item ?? null,
			createdAt: r.createdAt,
		}));
	};

	/** @info - Admin community directory: every community (incl. archived)
	 * with owner name, member + course counts. Newest first, 100 cap. */
	communities = async (params?: { search?: string }) => {
		const db = getDb();
		const where = params?.search?.trim()
			? sql`lower(${communities.name}) like ${`%${params.search.trim().toLowerCase()}%`}`
			: undefined;

		const rows = (await db
			.select({
				id: communities.id,
				name: communities.name,
				slug: communities.slug,
				visibility: communities.visibility,
				deletedAt: communities.deletedAt,
				createdAt: communities.createdAt,
				ownerName: sql<string>`concat(${users.firstName}, ' ', ${users.lastName})`,
			})
			.from(communities)
			.innerJoin(users, eq(users.id, communities.ownerId))
			.where(where)
			.orderBy(desc(communities.createdAt))
			.limit(100)) as any[];

		const ids = rows.map((r) => r.id);
		if (!ids.length) return [];
		const [memberRows, courseRows] = await Promise.all([
			db
				.select({ communityId: communityMembers.communityId, value: count() })
				.from(communityMembers)
				.where(inArray(communityMembers.communityId, ids))
				.groupBy(communityMembers.communityId) as any,
			db
				.select({ communityId: courses.communityId, value: count() })
				.from(courses)
				.where(inArray(courses.communityId, ids))
				.groupBy(courses.communityId) as any,
		]);
		const memberMap = new Map((memberRows as any[]).map((r) => [Number(r.communityId), Number(r.value)]));
		const courseMap = new Map((courseRows as any[]).map((r) => [Number(r.communityId), Number(r.value)]));

		return rows.map((r) => ({
			id: r.id,
			name: r.name,
			slug: r.slug,
			visibility: r.visibility,
			status: r.deletedAt ? "archived" : "active",
			ownerName: r.ownerName ?? "Unknown",
			members: memberMap.get(r.id) ?? 0,
			courses: courseMap.get(r.id) ?? 0,
			createdAt: r.createdAt,
		}));
	};

	/** @info - Admin user list: search by name/email, optional role filter,
	 * with role badges + enrollment counts (no pagination UI yet — 100 cap). */
	users = async (params?: { search?: string; role?: string }) => {
		const db = getDb();

		const conditions: any[] = [];
		if (params?.search?.trim()) {
			const q = `%${params.search.trim()}%`;
			conditions.push(or(like(users.firstName, q), like(users.lastName, q), like(users.email, q)));
		}

		const rows = (await db
			.select({
				id: users.id,
				firstName: users.firstName,
				lastName: users.lastName,
				email: users.email,
				avatarUrl: users.avatarUrl,
				createdAt: users.createdAt,
				suspendedAt: users.suspendedAt,
				deletedAt: users.deletedAt,
			})
			.from(users)
			.where(conditions.length ? and(...conditions) : undefined)
			.orderBy(desc(users.createdAt))
			.limit(100)) as any[];

		const ids = rows.map((r) => r.id);
		const [roleRows, enrollRows] = await Promise.all([
			ids.length
				? (db
						.select({ userId: user_roles.userId, role: user_roles.role })
						.from(user_roles)
						.where(inArray(user_roles.userId, ids))) as any
				: [],
			ids.length
				? (db
						.select({ userId: enrollments.userId, total: count() })
						.from(enrollments)
						.where(inArray(enrollments.userId, ids))
						.groupBy(enrollments.userId)) as any
				: [],
		]);

		const roleMap = new Map<number, string[]>();
		for (const r of roleRows) {
			roleMap.set(Number(r.userId), [...(roleMap.get(Number(r.userId)) ?? []), r.role]);
		}
		const enrollMap = new Map((enrollRows as any[]).map((r) => [Number(r.userId), Number(r.total)]));

		let result = rows.map((u) => ({
			id: u.id,
			name: `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || "—",
			email: u.email,
			avatarUrl: u.avatarUrl
				? withPresignedUrl({ avatarUrl: u.avatarUrl }, "avatarUrl").avatarUrl
				: null,
			roles: roleMap.get(u.id) ?? [],
			enrollmentCount: enrollMap.get(u.id) ?? 0,
			joinedAt: u.createdAt,
			status: u.deletedAt ? "deleted" : u.suspendedAt ? "suspended" : "active",
		}));

		if (params?.role && params.role !== "all") {
			result = result.filter((u) => u.roles.includes(params.role!));
		}

		return result;
	};

	/** @info - Platform activity log: real events (users, payments,
	 * enrollments, communities, withdrawals, reviews, certificates)
	 * merged into one time-ordered feed. Search matches user/detail. */
	activityLogs = async (params?: { search?: string }) => {
		const db = getDb();
		const naira = (kobo: number) => `₦${Math.round(kobo / 100).toLocaleString("en-US")}`;

		const [userRows, payRows, enrollRows, commRows, wdRows, reviewRows, certRows] = await Promise.all([
			db
				.select({ email: users.email, time: users.createdAt })
				.from(users)
				.orderBy(desc(users.createdAt))
				.limit(100) as any,
			db
				.select({
					email: users.email,
					amount: payments.amount,
					time: payments.createdAt,
					item: sql<string>`coalesce(${courses.title}, ${communities.name})`,
				})
				.from(payments)
				.innerJoin(users, eq(users.id, payments.payerId))
				.leftJoin(courses, eq(courses.id, payments.courseId))
				.leftJoin(communities, eq(communities.id, payments.communityId))
				.orderBy(desc(payments.createdAt))
				.limit(100) as any,
			db
				.select({ email: users.email, title: courses.title, time: enrollments.createdAt })
				.from(enrollments)
				.innerJoin(users, eq(users.id, enrollments.userId))
				.innerJoin(courses, eq(courses.id, enrollments.courseId))
				.orderBy(desc(enrollments.createdAt))
				.limit(100) as any,
			db
				.select({ email: users.email, name: communities.name, time: communities.createdAt })
				.from(communities)
				.innerJoin(users, eq(users.id, communities.ownerId))
				.orderBy(desc(communities.createdAt))
				.limit(100) as any,
			db
				.select({
					email: users.email,
					amount: withdrawals.amount,
					bankName: withdrawals.bankName,
					time: withdrawals.requestedAt,
				})
				.from(withdrawals)
				.innerJoin(users, eq(users.id, withdrawals.instructorId))
				.orderBy(desc(withdrawals.requestedAt))
				.limit(100) as any,
			db
				.select({ email: users.email, rating: reviews.rating, title: courses.title, time: reviews.createdAt })
				.from(reviews)
				.innerJoin(users, eq(users.id, reviews.userId))
				.innerJoin(courses, eq(courses.id, reviews.courseId))
				.orderBy(desc(reviews.createdAt))
				.limit(100) as any,
			db
				.select({ email: users.email, title: courses.title, time: certificates.issuedAt })
				.from(certificates)
				.innerJoin(users, eq(users.id, certificates.userId))
				.innerJoin(courses, eq(courses.id, certificates.courseId))
				.orderBy(desc(certificates.issuedAt))
				.limit(100) as any,
		]);

		const feed: { user: string; action: string; resource: string; detail: string; time: string }[] = [];
		for (const r of userRows as any[]) {
			feed.push({ user: r.email ?? "Someone", action: "Joined Hive", resource: "User", detail: "New account created", time: r.time });
		}
		for (const r of payRows as any[]) {
			feed.push({ user: r.email ?? "A student", action: "Paid for enrollment", resource: "Payment", detail: `${naira(r.amount ?? 0)} - ${r.item ?? "—"}`, time: r.time });
		}
		for (const r of enrollRows as any[]) {
			feed.push({ user: r.email ?? "A student", action: "Enrolled", resource: "Enrollment", detail: r.title ?? "a course", time: r.time });
		}
		for (const r of commRows as any[]) {
			feed.push({ user: r.email ?? "Someone", action: "Created community", resource: "Community", detail: r.name ?? "—", time: r.time });
		}
		for (const r of wdRows as any[]) {
			feed.push({ user: r.email ?? "An instructor", action: "Requested withdrawal", resource: "Withdrawal", detail: `${naira(r.amount ?? 0)} to ${r.bankName ?? "bank"}`, time: r.time });
		}
		for (const r of reviewRows as any[]) {
			feed.push({ user: r.email ?? "A student", action: `Left a ${r.rating}/5 review`, resource: "Review", detail: r.title ?? "a course", time: r.time });
		}
		for (const r of certRows as any[]) {
			feed.push({ user: r.email ?? "A student", action: "Earned certificate", resource: "Certificate", detail: r.title ?? "a course", time: r.time });
		}

		let sorted = feed
			.filter((r) => r.time)
			.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

		if (params?.search?.trim()) {
			const q = params.search.trim().toLowerCase();
			sorted = sorted.filter(
				(r) =>
					r.user.toLowerCase().includes(q) ||
					r.detail.toLowerCase().includes(q) ||
					r.resource.toLowerCase().includes(q),
			);
		}

		return sorted.slice(0, 100).map((r, i) => ({ id: i, ...r }));
	};

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
