import { eq } from "drizzle-orm";
import { throwBadRequestError } from "@/helpers/errors/throw-errors";
import { serviceLogger } from "@/utils";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { EnrollmentMessages } from "./enrollment.message";
import {
	EnrollmentRepository,
	LessonProgressRepository,
} from "./enrollment.repository";
import type { NewEnrollment } from "./enrollment.model";

export class EnrollmentService {
	private static instance: EnrollmentService;
	private enrollments: EnrollmentRepository;
	private progress: LessonProgressRepository;

	/** @info - Utilities */
	private readonly log = serviceLogger("Enrollment");

	static getInstance(): EnrollmentService {
		if (!this.instance) this.instance = new EnrollmentService();
		return this.instance;
	}

	private constructor() {
		this.enrollments = EnrollmentRepository.getInstance();
		this.progress = LessonProgressRepository.getInstance();
	}

	enroll = async (authData: IAuthData, courseId: number) => {
		/* Dedup: do not enroll twice */
		const existing = await this.enrollments.findOne(
			eq(this.enrollments.getModel().userId as any, authData.id),
		);

		if (existing) {
			return existing;
		}

		return this.enrollments.create({
			userId: authData.id,
			courseId,
		} as any as NewEnrollment);
	};

	list = async (authData: IAuthData) => {
		return this.enrollments.findMany(
			eq(this.enrollments.getModel().userId as any, authData.id),
		);
	};

	get = async (id: number) => {
		return this.enrollments.findById(id);
	};

	markLessonComplete = async (
		authData: IAuthData,
		enrollmentId: number,
		lessonId: number,
	) => {
		return this.progress.upsertProgress(enrollmentId, lessonId, authData.id);
	};

	getLessonProgress = async (enrollmentId: number) => {
		return this.progress.findByEnrollment(enrollmentId);
	};
}
