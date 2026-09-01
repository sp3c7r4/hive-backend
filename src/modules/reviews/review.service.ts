import { and, avg, count, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import { withTransaction } from "@/helpers/db.helper";
import {
	throwBadRequestError,
	throwNotFoundError,
} from "@/helpers/errors/throw-errors";
import { withPresignedUrl } from "@/helpers/storage.helper";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { courses } from "@/modules/courses/course.model";
import { enrollments } from "@/modules/enrollments/enrollment.model";
import { users } from "@/modules/user/user.model";
import { reviews } from "./review.model";
import { NotificationService } from "@/modules/notifications";
import { NotificationType } from "@/enums";

/** @info - Course reviews: enrolled-student-only 1-5 stars, one per user
 * (upsert), with cached aggregates on the courses row. */
export class ReviewService {
	private static instance: ReviewService;

	static getInstance(): ReviewService {
		if (!this.instance) this.instance = new ReviewService();
		return this.instance;
	}

	private constructor() {}

	/** @info - Recompute + persist aggregates on the courses row. */
	private refreshAggregate = async (courseId: number) => {
		const db = getDb();
		const [row] = await db
			.select({ value: avg(reviews.rating), total: count() })
			.from(reviews)
			.where(eq(reviews.courseId, courseId));
		const average = row?.value ? Math.round(Number(row.value) * 10) / 10 : 0;
		await db
			.update(courses)
			.set({
				averageRating: average as any,
				reviewCount: Number(row?.total ?? 0),
			})
			.where(eq(courses.id, courseId));
	};

	create = async (
		authData: IAuthData,
		params: { courseId: number; rating: number; title?: string; comment: string },
	) => {
		const { courseId, rating, title, comment } = params;
		if (!Number.isInteger(rating) || rating < 1 || rating > 5)
			throwBadRequestError("Rating must be a whole number between 1 and 5");
		if (!comment?.trim()) throwBadRequestError("Review comment is required");
		if ((title?.length ?? 0) > 255)
			throwBadRequestError("Review title is too long");

		const db = getDb();
		const [course] = await db
			.select({ id: courses.id, instructorId: courses.instructorId })
			.from(courses)
			.where(eq(courses.id, courseId))
			.limit(1);
		if (!course) throwNotFoundError("Course not found");

		/* @info - Only enrolled students may review */
		const [enrollment] = await db
			.select({ id: enrollments.id })
			.from(enrollments)
			.where(
				and(
					eq(enrollments.userId, Number(authData.id)),
					eq(enrollments.courseId, courseId),
				),
			)
			.limit(1);
		if (!enrollment) throwBadRequestError("Enroll in the course before reviewing it");

		const [existing] = await db
			.select({ id: reviews.id })
			.from(reviews)
			.where(
				and(
					eq(reviews.courseId, courseId),
					eq(reviews.userId, Number(authData.id)),
				),
			)
			.limit(1);

		let savedId: number;
		await withTransaction(async (tx) => {
			if (existing) {
				await tx
					.update(reviews)
					.set({ rating, title: title ?? null, comment })
					.where(eq(reviews.id, existing.id));
				savedId = existing.id;
			} else {
				const [inserted] = await tx
					.insert(reviews)
					.values({
						courseId,
						userId: Number(authData.id),
						rating,
						title: title ?? null,
						comment,
					})
					.returning({ id: reviews.id });
				savedId = inserted!.id;
			}
		});

		await this.refreshAggregate(courseId);

		/* @info - Notify the instructor of their new review */
		NotificationService.getInstance().notify(
			Number(course!.instructorId),
			NotificationType.REVIEW,
			"New course review",
			`${rating}/5 - ${comment.slice(0, 100)}${comment.length > 100 ? "…" : ""}`,
			{ courseId, reviewId: savedId! },
		);

		const [saved] = await db
			.select()
			.from(reviews)
			.where(eq(reviews.id, savedId!))
			.limit(1);
		return saved;
	};

	listByCourse = async (courseId: number, authData?: IAuthData) => {
		const db = getDb();
		const rows = await db
			.select({
				id: reviews.id,
				rating: reviews.rating,
				title: reviews.title,
				comment: reviews.comment,
				createdAt: reviews.createdAt,
				userName: users.firstName,
				avatarUrl: users.avatarUrl,
				helpfulCount: reviews.helpfulCount,
				helpfulByUserIds: reviews.helpfulByUserIds,
			})
			.from(reviews)
			.innerJoin(users, eq(users.id, reviews.userId))
			.where(eq(reviews.courseId, courseId))
			.orderBy(desc(reviews.createdAt));

		const [agg] = await db
			.select({ value: avg(reviews.rating), total: count() })
			.from(reviews)
			.where(eq(reviews.courseId, courseId));
		const total = Number(agg?.total ?? 0);
		const average = total && agg?.value ? Math.round(Number(agg.value) * 10) / 10 : 0;

		const dist = await db
			.select({ rating: reviews.rating, total: count() })
			.from(reviews)
			.where(eq(reviews.courseId, courseId))
			.groupBy(reviews.rating);
		const distribution: Record<number, number> = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
		for (const d of dist) distribution[d.rating] = Number(d.total);

		return {
			reviews: rows.map((r) => ({
				...r,
				userName: `${r.userName ?? ""}`.trim() || "Student",
				markedHelpful: (r.helpfulByUserIds ?? []).includes(Number(authData?.id)),
				helpfulByUserIds: undefined,
				avatarUrl: r.avatarUrl
					? withPresignedUrl({ avatar: r.avatarUrl } as any, "avatar").avatar
					: null,
			})),
			summary: { count: total, average, distribution },
		};
	};

	toggleHelpful = async (authData: IAuthData, reviewId: number) => {
		const db = getDb();
		const [row] = await db
			.select()
			.from(reviews)
			.where(eq(reviews.id, reviewId))
			.limit(1);
		if (!row) throwNotFoundError("Review not found");
		const row0 = row!;

		const list: number[] = row0.helpfulByUserIds ?? [];
		const userId = Number(authData.id);
		const marked = list.includes(userId);
		const next = marked ? list.filter((u) => u !== userId) : [...list, userId];

		const [updated] = await db
			.update(reviews)
			.set({ helpfulByUserIds: next, helpfulCount: next.length })
			.where(eq(reviews.id, reviewId))
			.returning({ helpfulCount: reviews.helpfulCount });
		return { helpfulCount: updated?.helpfulCount ?? next.length, markedHelpful: !marked };
	};

	myReview = async (authData: IAuthData, courseId: number) => {
		const db = getDb();
		const [row] = await db
			.select()
			.from(reviews)
			.where(
				and(
					eq(reviews.courseId, courseId),
					eq(reviews.userId, Number(authData.id)),
				),
			)
			.limit(1);
		return row ?? null;
	};
}
