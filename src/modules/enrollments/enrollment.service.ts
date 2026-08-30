import { and, count, eq } from "drizzle-orm";
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
import { courses, lessons, modules } from "@/modules/courses/course.model";
import { enrollments as enrollmentsModel } from "./enrollment.model";
import { communities } from "@/modules/communities/community.model";
import { payments } from "@/modules/payment/payment.model";
import { quizAttempts } from "@/modules/assessments/assessment.model";
import { CertificateQueueService } from "@/services/queues/certificate.queue.service";

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
    const row = await this.progress.upsertProgress(enrollmentId, lessonId, authData.id);

    /* @info - After marking, check whether the course is now complete enough
     * to earn a certificate; if so, enqueue generation (idempotent per
     * user+course, so repeated completes never double-generate). */
    try {
      await this._maybeQueueCertificate(authData.id, enrollmentId);
    } catch (e) {
      this.log.error("Could not evaluate certificate eligibility", {
        error: e,
        enrollmentId,
      });
    }

    return row;
  };

  private _maybeQueueCertificate = async (userId: number, enrollmentId: number) => {
    const db = getDb();

    const [enrollment] = await db
      .select({ courseId: enrollmentsModel.courseId })
      .from(enrollmentsModel)
      .where(eq(enrollmentsModel.id, enrollmentId))
      .limit(1);
    if (!enrollment) return;

    const [course] = await db
      .select({
        offerCertificate: courses.offerCertificate,
        minCompletionPercent: courses.minCompletionPercent,
        minQuizScorePercent: courses.minQuizScorePercent,
      })
      .from(courses)
      .where(eq(courses.id, enrollment.courseId))
      .limit(1);
    if (!course?.offerCertificate) return;

    /* Total + completed lessons for this enrollment */
    const progressRows = await this.progress.findByEnrollment(enrollmentId);
    const totalLessons = await this._countCourseLessons(enrollment.courseId);
    if (totalLessons === 0) return;
    const completedCount = progressRows.filter((p: any) => p.completed).length;
    const completionPercent = Math.round((completedCount / totalLessons) * 100);

    if (completionPercent < (course.minCompletionPercent ?? 80)) return;

    /* Quiz score: average per-quiz-lesson score (correct/total). No quiz
     * lessons → 100 (passes any threshold). */
    const quizScorePercent = await this._courseQuizScore(userId, enrollment.courseId);
    if (quizScorePercent < (course.minQuizScorePercent ?? 0)) return;

    await CertificateQueueService.getInstance().queueCertificate({
      userId,
      courseId: enrollment.courseId,
      enrollmentId,
      completionPercent,
      quizScorePercent,
    });
  };

  private _countCourseLessons = async (courseId: number): Promise<number> => {
    const db = getDb();
    const [row] = await db
      .select({ total: count() })
      .from(lessons)
      .innerJoin(modules, eq(modules.id, lessons.moduleId))
      .where(eq(modules.courseId, courseId));
    return Number(row?.total ?? 0);
  };

  private _courseQuizScore = async (userId: number, courseId: number): Promise<number> => {
    const db = getDb();
    const quizLessonRows = await db
      .select({ lessonId: lessons.id })
      .from(lessons)
      .innerJoin(modules, eq(modules.id, lessons.moduleId))
      .where(and(eq(modules.courseId, courseId), eq(lessons.type, "quiz" as any)));
    if (quizLessonRows.length === 0) return 100;

    let totalPercent = 0;
    for (const { lessonId } of quizLessonRows) {
      const [stats] = await db
        .select({ correct: count() })
        .from(quizAttempts)
        .where(
          and(
            eq(quizAttempts.userId, userId),
            eq(quizAttempts.lessonId, lessonId),
            eq(quizAttempts.isCorrect, true),
          ),
        );
      const [attempts] = await db
        .select({ total: count() })
        .from(quizAttempts)
        .where(
          and(
            eq(quizAttempts.userId, userId),
            eq(quizAttempts.lessonId, lessonId),
          ),
        );
      const attemptTotal = Number(attempts?.total ?? 0);
      if (attemptTotal > 0) {
        totalPercent += (Number(stats?.correct ?? 0) / attemptTotal) * 100;
      }
    }
    return Math.round(totalPercent / quizLessonRows.length);
  };

	getLessonProgress = async (enrollmentId: number) => {
		return this.progress.findByEnrollment(enrollmentId);
	};
}
