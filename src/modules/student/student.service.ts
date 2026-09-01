import { and, count, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import { withPresignedUrl } from "@/helpers/storage.helper";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { courses, lessons, modules } from "@/modules/courses/course.model";
import { users } from "@/modules/user/user.model";
import { enrollments, lessonProgress } from "@/modules/enrollments/enrollment.model";
import { payments } from "@/modules/payment/payment.model";
import { assignmentSubmissions } from "@/modules/assessments/assessment.model";
import { certificates } from "@/modules/certificates/certificate.model";

/** @info - One round trip for the student dashboard: real continue-learning
 * progress, due-soon assignments, the student's own activity feed, and any
 * earned certificates. */
export class StudentDashboardService {
	private static instance: StudentDashboardService;

	static getInstance(): StudentDashboardService {
		if (!this.instance) this.instance = new StudentDashboardService();
		return this.instance;
	}

	private constructor() {}

	dashboard = async (authData: IAuthData) => {
		const db = getDb();
		const userId = Number(authData.id);

		const [enrollRows, progressRows, lessonCounts, assignRows, subRows, payRows, certRows, certList] =
			await Promise.all([
				db
					.select({
						enrollmentId: enrollments.id,
						courseId: courses.id,
						title: courses.title,
						slug: courses.slug,
						coverImageUrl: courses.coverImageUrl,
						instructorName: users.firstName,
						enrolledAt: enrollments.createdAt,
					})
					.from(enrollments)
					.innerJoin(courses, eq(courses.id, enrollments.courseId))
					.innerJoin(users, eq(users.id, courses.instructorId))
					.where(eq(enrollments.userId, userId))
					.orderBy(desc(enrollments.createdAt)) as any,
				db
					.select({
						enrollmentId: lessonProgress.enrollmentId,
						total: count(),
					})
					.from(lessonProgress)
					.innerJoin(enrollments, eq(enrollments.id, lessonProgress.enrollmentId))
					.where(and(
						eq(enrollments.userId, userId),
						eq(lessonProgress.completed, true),
					))
					.groupBy(lessonProgress.enrollmentId) as any,
				db
					.select({ courseId: modules.courseId, total: count() })
					.from(lessons)
					.innerJoin(modules, eq(modules.id, lessons.moduleId))
					.groupBy(modules.courseId) as any,
				db
					.select({
						lessonId: lessons.id,
						title: lessons.title,
						settings: lessons.settings,
						courseId: modules.courseId,
						courseTitle: courses.title,
						courseSlug: courses.slug,
					})
					.from(lessons)
					.innerJoin(modules, eq(modules.id, lessons.moduleId))
					.innerJoin(courses, eq(courses.id, modules.courseId))
					.innerJoin(enrollments, eq(enrollments.courseId, courses.id))
					.where(and(
						eq(enrollments.userId, userId),
						eq(lessons.type, "assignment" as any),
					)) as any,
				db
					.select({ lessonId: assignmentSubmissions.lessonId, status: assignmentSubmissions.status })
					.from(assignmentSubmissions)
					.where(eq(assignmentSubmissions.userId, userId)) as any,
				db
					.select({ id: payments.id, title: courses.title, amount: payments.amount, time: payments.createdAt })
					.from(payments)
					.innerJoin(courses, eq(courses.id, payments.courseId))
					.where(and(eq(payments.payerId, userId), eq(payments.status, "success" as any)))
					.orderBy(desc(payments.createdAt))
					.limit(10) as any,
				db
					.select({
						id: certificates.id,
						title: courses.title,
						time: certificates.issuedAt,
					})
					.from(certificates)
					.innerJoin(courses, eq(courses.id, certificates.courseId))
					.where(eq(certificates.userId, userId))
					.orderBy(desc(certificates.issuedAt))
					.limit(10) as any,
				db
					.select({
						code: certificates.code,
						courseTitle: courses.title,
						issuedAt: certificates.issuedAt,
						fileUrl: certificates.fileUrl,
					})
					.from(certificates)
					.innerJoin(courses, eq(courses.id, certificates.courseId))
					.where(eq(certificates.userId, userId))
					.orderBy(desc(certificates.issuedAt))
					.limit(3) as any,
			]);

		/* Continue learning — real progress per enrollment */
		const completedMap = new Map(
			(progressRows as any[]).map((r) => [Number(r.enrollmentId), Number(r.total)]),
		);
		const lessonTotalMap = new Map(
			(lessonCounts as any[]).map((r) => [Number(r.courseId), Number(r.total)]),
		);
		const continueLearning = (enrollRows as any[]).map((e) => {
			const total = lessonTotalMap.get(e.courseId) ?? 0;
			const done = completedMap.get(e.enrollmentId) ?? 0;
			return {
				courseId: e.courseId,
				title: e.title,
				slug: e.slug,
				coverImageUrl: e.coverImageUrl
					? withPresignedUrl({ coverImageUrl: e.coverImageUrl } as any, "coverImageUrl").coverImageUrl
					: null,
				instructorName: `${e.instructorName ?? ""}`.trim() || "Instructor",
				progressPercent: total > 0 ? Math.round((done / total) * 100) : 0,
			};
		});

		/* Due soon — real assignment lessons with due dates */
		const subStatusMap = new Map(
			(subRows as any[]).map((r) => [Number(r.lessonId), r.status]),
		);
		const now = Date.now();
		const dueSoon = (assignRows as any[])
			.map((l: any) => {
				const due = (l.settings as Record<string, any> | null)?.dueDate as string | null;
				if (!due) return null;
				const dueAt = new Date(due).getTime();
				if (Number.isNaN(dueAt) || dueAt < now) return null;
				return {
					lessonId: l.lessonId,
					title: l.title ?? "Assignment",
					courseTitle: l.courseTitle ?? "Course",
					courseSlug: l.courseSlug,
					dueAt: new Date(dueAt).toISOString(),
					submissionStatus: subStatusMap.get(Number(l.lessonId)) ?? null,
				};
			})
			.filter((x: any) => x !== null)
			.sort((a: any, b: any) => a.dueAt.localeCompare(b.dueAt))
			.slice(0, 5);

		/* Recent activity — the student's own events */
		const naira = (kobo: number) => `₦${Math.round(kobo / 100).toLocaleString("en-US")}`;
		const enrollFeed = (enrollRows as any[]).map((r) => ({
			type: "enrollment",
			text: `You enrolled in ${r.title}`,
			time: r.enrolledAt,
		}));
		const payFeed = (payRows as any[]).map((r) => ({
			type: "payment",
			text: `You paid ${naira(r.amount ?? 0)} for ${r.title}`,
			time: r.time,
		}));
		const subFeed = (subRows as any[]).map((r) => ({
			type: "submission",
			text: `You submitted ${r.title ?? "an assignment"}`,
			time: null,
		}));
		const certFeed = (certRows as any[]).map((r) => ({
			type: "certificate",
			text: `You earned a certificate for ${r.title}`,
			time: r.time,
		}));
		const recentActivity = [...enrollFeed, ...payFeed, ...subFeed, ...certFeed]
			.filter((r) => r.time)
			.sort((a, b) => new Date(b.time!).getTime() - new Date(a.time!).getTime())
			.slice(0, 10)
			.map((r, i) => ({ id: i, type: r.type, text: r.text, time: r.time!.toISOString() }));

		const certificatesList = (certList as any[]).map((c) => ({
			code: c.code,
			courseTitle: c.courseTitle ?? "Course",
			issuedAt: c.issuedAt,
			fileUrl: c.fileUrl ? withPresignedUrl(c, "fileUrl").fileUrl : null,
		}));

		return { continueLearning, dueSoon, recentActivity, certificates: certificatesList };
	};
}
