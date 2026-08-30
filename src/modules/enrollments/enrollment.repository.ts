import { RelationalRepository } from "@/bases";
import { enrollments, lessonProgress } from "./enrollment.model";
import { eq, and } from "drizzle-orm";

export class EnrollmentRepository extends RelationalRepository<typeof enrollments> {
	private static instance: EnrollmentRepository;

	static getInstance(): EnrollmentRepository {
		if (!this.instance) this.instance = new EnrollmentRepository();
		return this.instance;
	}

	private constructor() {
		super(enrollments);
	}

	findByUserAndCourse = async (userId: number, courseId: number) => {
		return this.findOne(
			and(
				eq(enrollments.userId, userId),
				eq(enrollments.courseId, courseId),
			) as any,
		);
	};
}

export class LessonProgressRepository extends RelationalRepository<typeof lessonProgress> {
	private static instance: LessonProgressRepository;

	static getInstance(): LessonProgressRepository {
		if (!this.instance) this.instance = new LessonProgressRepository();
		return this.instance;
	}

	private constructor() {
		super(lessonProgress);
	}

	findByEnrollmentAndLesson = async (enrollmentId: number, lessonId: number) => {
		return this.findOne(
			and(
				eq(lessonProgress.enrollmentId, enrollmentId),
				eq(lessonProgress.lessonId, lessonId),
			) as any,
		);
	};

	findByEnrollment = async (enrollmentId: number) => {
		return this.findMany(
			eq(lessonProgress.enrollmentId, enrollmentId),
		);
	};

	upsertProgress = async (enrollmentId: number, lessonId: number, _userId: number) => {
		const existing = await this.findByEnrollmentAndLesson(enrollmentId, lessonId);
		if (existing) {
			return this.update(existing.id, { completed: true, completedAt: new Date() } as any);
		}
		return this.create({
			enrollmentId,
			lessonId,
			completed: true,
			completedAt: new Date(),
		} as any);
	};
}
