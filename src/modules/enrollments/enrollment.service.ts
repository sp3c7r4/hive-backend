import { eq } from "drizzle-orm";
import { EnrollmentRepository, LessonProgressRepository } from "./enrollment.repository";
import type { NewEnrollment } from "./enrollment.model";

export class EnrollmentService {
	private static instance: EnrollmentService;

	private readonly enrollments: EnrollmentRepository;
	private readonly progress: LessonProgressRepository;

	static getInstance(): EnrollmentService {
		if (!this.instance) this.instance = new EnrollmentService();
		return this.instance;
	}

	private constructor() {
		this.enrollments = EnrollmentRepository.getInstance();
		this.progress = LessonProgressRepository.getInstance();
	}

	enroll = async (data: NewEnrollment) => {
		/** @info - Prevent duplicate enrollment */
		const existing = await this.enrollments.findByUserAndCourse(
			data.userId,
			data.courseId,
		);
		if (existing) {
			return existing;
		}

		return this.enrollments.create(data as any);
	};

	getEnrollment = async (id: number) => {
		return this.enrollments.findById(id);
	};

	listUserEnrollments = async (userId: number) => {
		return this.enrollments.findMany(
			eq(this.enrollments.getModel().userId as any, userId),
		);
	};

	/** @info - Lesson progress */
	markLessonComplete = async (enrollmentId: number, lessonId: number) => {
		const existing = await this.progress.findByEnrollmentAndLesson(
			enrollmentId,
			lessonId,
		);

		if (existing) {
			return this.progress.update(existing.id, {
				completed: true,
				completedAt: new Date(),
			} as any);
		}

		return this.progress.create({
			enrollmentId,
			lessonId,
			completed: true,
			completedAt: new Date(),
		} as any);
	};

	getLessonProgress = async (enrollmentId: number) => {
		return this.progress.findByEnrollment(enrollmentId);
	};

	updateProgressPercent = async (enrollmentId: number, percent: number) => {
		return this.enrollments.update(enrollmentId, {
			progressPercent: percent,
		} as any);
	};
}
