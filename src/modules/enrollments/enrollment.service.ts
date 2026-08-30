import { and, eq } from "drizzle-orm";
import { throwBadRequestError, throwNotFoundError } from "@/helpers/errors/throw-errors";
import { serviceLogger } from "@/utils";
import { config } from "@/config";
import { getDb } from "@/db/postgres.db";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { EmailJobNames } from "@/enums";
import { EmailQueueService } from "@/services/queues/email.queue.service";
import { EnrollmentMessages } from "./enrollment.message";
import {
	EnrollmentRepository,
	LessonProgressRepository,
} from "./enrollment.repository";
import type { NewEnrollment } from "./enrollment.model";
import { courses } from "@/modules/courses/course.model";
import { communities } from "@/modules/communities/community.model";
import { payments } from "@/modules/payment/payment.model";

export class EnrollmentService {
	private static instance: EnrollmentService;
	private enrollments: EnrollmentRepository;
	private progress: LessonProgressRepository;
	private readonly emailQueue = EmailQueueService.getInstance();

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

	enroll = async (authData: IAuthData, courseId: number, paymentReference?: string) => {
		/* Dedup: do not enroll twice (user + course — not just user) */
		const existing = await this.enrollments.findOne(
			and(
				eq(this.enrollments.getModel().userId as any, authData.id),
				eq(this.enrollments.getModel().courseId as any, courseId),
			)!,
		);

		if (existing) {
			return existing;
		}

		const db = getDb();
		const [courseRow] = await db
			.select({ title: courses.title, communityId: courses.communityId, price: courses.price })
			.from(courses)
			.where(eq(courses.id, courseId))
			.limit(1);
		if (!courseRow) throwNotFoundError("Course not found");

		/* @info - Paid-course gate: a success payment for THIS course + user is required */
		let payment: { id: number } | undefined;
		if ((courseRow!.price ?? 0) > 0) {
			if (!paymentReference) throwBadRequestError("Payment required for this course");
			[payment] = await db
				.select({ id: payments.id })
				.from(payments)
				.where(
					and(
						eq(payments.reference, paymentReference!),
						eq(payments.status, "success" as any),
						eq(payments.payerId, Number(authData.id)),
						eq(payments.courseId, courseId),
					)!,
				)
				.limit(1);
			if (!payment) throwBadRequestError("Valid payment required for this course");
		}

		const enrollment = await this.enrollments.create({
			userId: authData.id,
			courseId,
		} as any as NewEnrollment);

		/* @info - Link the paid payment to the created enrollment */
		if (payment) {
			await db
				.update(payments)
				.set({ enrollmentId: enrollment.id })
				.where(eq(payments.id, payment!.id));
		}

		/* Queue enrollment-confirmed email */
		let communityName = "Hive";
		if (courseRow!.communityId) {
			const [commRow] = await db
				.select({ name: communities.name })
				.from(communities)
				.where(eq(communities.id, courseRow!.communityId))
				.limit(1);
			communityName = commRow?.name ?? "Hive";
		}

		this.emailQueue.add(EmailJobNames.ENROLLMENT_CONFIRMED as any, {
			message: {
				to: authData.email!,
				subject: `You're enrolled in ${courseRow!.title ?? "your course"}!`,
			},
			template: "enrollment-confirmed" as any,
			locals: {
				studentName: authData.firstName ?? "there",
				courseName: courseRow!.title ?? "your course",
				communityName,
				enrolledAt: new Date().toLocaleDateString("en-US", {
					year: "numeric",
					month: "long",
					day: "numeric",
				}),
				dashboardUrl: `${config.server.rootDomain}/dashboard`,
			},
		});

		return enrollment;
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
