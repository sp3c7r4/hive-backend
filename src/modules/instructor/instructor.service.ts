import { eq, count, sql, desc, and, gte, lte, sum } from "drizzle-orm";
import { throwNotFoundError } from "@/helpers/errors/throw-errors";
import { serviceLogger } from "@/utils";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { InstructorMessages } from "./instructor.message";
import { instructors } from "./instructor.model";
import { courses } from "@/modules/courses/course.model";
import { lessons } from "@/modules/courses/course.model";
import { enrollments } from "@/modules/enrollments/enrollment.model";
import { reviews } from "@/modules/reviews/review.model";
import { CourseRepository } from "@/modules/courses/course.repository";
import { getDb } from "@/db/postgres.db";

export class InstructorService {
	private static instance: InstructorService;
	private coursesRepo: CourseRepository;

	/** @info - Utilities */
	private readonly log = serviceLogger("Instructor");

	static getInstance(): InstructorService {
		if (!this.instance) this.instance = new InstructorService();
		return this.instance;
	}

	private constructor() {
		this.coursesRepo = CourseRepository.getInstance();
	}

	/* Dashboard stats */

	getStats = async (authData: IAuthData, params?: { from?: string; to?: string }) => {
		const db = getDb();
		const instructorId = authData.id;

		/* Total courses */
		const courseResult = await db
			.select({ value: count() })
			.from(courses)
			.where(eq(courses.instructorId, instructorId));
		const totalCourses = Number(courseResult[0]?.value ?? 0);

		/* Total students (unique enrollments across instructor's courses) */
		const enrollResult = await db
			.select({ value: count() })
			.from(enrollments)
			.innerJoin(courses, eq(enrollments.courseId, courses.id))
			.where(eq(courses.instructorId, instructorId));
		const totalStudents = Number(enrollResult[0]?.value ?? 0);

		/* Average rating across instructor's courses */
		const ratingResult = await db
			.select({ avg: sql<number>`COALESCE(AVG(${courses.averageRating}), 0)` })
			.from(courses)
			.where(
				and(
					eq(courses.instructorId, instructorId),
					eq(courses.deleted_at, null as any),
				),
			);
		const avgRating = Math.round((ratingResult[0]?.avg ?? 0) / 10 * 10) / 10;

		/* Total revenue (sum of course prices × enrollment count) */
		const revResult = await db
			.select({ rev: sql<number>`COALESCE(SUM(${courses.price} * ${courses.enrollmentCount}), 0)` })
			.from(courses)
			.where(eq(courses.instructorId, instructorId));
		const totalRevenue = Number(revResult[0]?.rev ?? 0);

		/* Live classes */
		const liveResult = await db
			.select({ value: count() })
			.from(lessons)
			.innerJoin(courses as any, eq(lessons.moduleId, courses.id as any))
			.where(
				and(
					eq(courses.instructorId, instructorId),
					eq(lessons.type, "live" as any),
				),
			);
		const liveClassCount = Number(liveResult[0]?.value ?? 0);

		return {
			totalStudents,
			totalCourses,
			totalRevenue,
			avgRating,
			liveClassCount,
		};
	};

	/* Live classes */

	getLiveClasses = async (
		authData: IAuthData,
		params?: { page?: number; limit?: number; filter?: string },
	) => {
		const db = getDb();

		const conditions = [
			eq(courses.instructorId as any, authData.id),
			eq(lessons.type, "live" as any),
		];

		const now = new Date().toISOString();
		if (params?.filter === "upcoming") {
			conditions.push(gte(lessons.liveMeetingDate as any, now));
		} else if (params?.filter === "past") {
			conditions.push(lte(lessons.liveMeetingDate as any, now));
		}

		const data = await db
			.select({
				id: lessons.id,
				title: lessons.title,
				liveMeetingLink: lessons.liveMeetingLink,
				liveMeetingDate: lessons.liveMeetingDate,
				duration: lessons.duration,
				courseId: courses.id,
				courseTitle: courses.title,
			})
			.from(lessons)
			.innerJoin(courses as any, eq(lessons.moduleId, courses.id as any))
			.where(and(...(conditions as any)))
			.orderBy(desc(lessons.liveMeetingDate))
			.limit(params?.limit ?? 5)
			.offset(((params?.page ?? 1) - 1) * (params?.limit ?? 5));

		return data;
	};
}
