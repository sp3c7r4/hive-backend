import { and, count, eq, ne } from "drizzle-orm";
import { throwBadRequestError, throwNotFoundError } from "@/helpers/errors/throw-errors";
import { serviceLogger } from "@/utils";
import { config } from "@/config";
import { getDb } from "@/db/postgres.db";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { EmailJobNames, LessonStatus } from "@/enums";
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
import { quizAttempts, quizQuestions } from "@/modules/assessments/assessment.model";
import { CertificateQueueService } from "@/services/queues/certificate.queue.service";
import {
	type CertificateEligibilityResult,
	type CertificateQuizInput,
	evaluateCertificateEligibility,
} from "@/helpers/certificate-eligibility";

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
			.select({
				title: courses.title,
				communityId: courses.communityId,
				price: courses.price,
				status: courses.status,
				deletedAt: courses.deletedAt,
			})
			.from(courses)
			.where(eq(courses.id, courseId))
			.limit(1);
		if (!courseRow) throwNotFoundError("Course not found");

		/* @info - Enrollment gate: draft/archived/soft-deleted courses are
		 * closed to NEW enrollments. A success payment for THIS user + course
		 * still admits (grace path) so paid-but-unseated buyers aren't locked
		 * out when a course is retired between checkout and enrollment. */
		if (courseRow!.deletedAt || courseRow!.status !== "published") {
			const [paid] = await db
				.select({ id: payments.id })
				.from(payments)
				.where(
					and(
						eq(payments.payerId, Number(authData.id)),
						eq(payments.courseId, courseId),
						eq(payments.status, "success" as any),
					)!,
				)
				.limit(1);
			if (!paid) {
				throwBadRequestError(
					"This course isn't currently accepting enrollments.",
				);
			}
		}

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

    /* @info - After marking, re-evaluate eligibility: enqueue generation when
     * the student now qualifies (idempotent per user+course, so repeated
     * completes never double-generate), and hand the verdict back either way
     * so the learner is told what is still missing instead of being left to
     * guess. */
    let eligibility: CertificateEligibilityResult | null = null;
    try {
      eligibility = await this._maybeQueueCertificate(authData.id, enrollmentId);
    } catch (e) {
      this.log.error("Could not evaluate certificate eligibility", {
        error: e,
        enrollmentId,
      });
    }

    return { row, eligibility };
  };

  /**
   * @info - Evaluates certificate eligibility for an enrollment and queues
   *         generation when it passes. Returns the full verdict, which is the
   *         same object the learner UI renders as a requirements checklist —
   *         the rules live in `evaluateCertificateEligibility`, not here.
   */
  private _maybeQueueCertificate = async (
    userId: number,
    enrollmentId: number,
  ): Promise<CertificateEligibilityResult | null> => {
    const db = getDb();

    const [enrollment] = await db
      .select({ courseId: enrollmentsModel.courseId })
      .from(enrollmentsModel)
      .where(eq(enrollmentsModel.id, enrollmentId))
      .limit(1);
    if (!enrollment) return null;

    const [course] = await db
      .select({
        offerCertificate: courses.offerCertificate,
        minCompletionPercent: courses.minCompletionPercent,
        minQuizScorePercent: courses.minQuizScorePercent,
      })
      .from(courses)
      .where(eq(courses.id, enrollment.courseId))
      .limit(1);
    if (!course) return null;

    const eligibility = await this.evaluateEligibility(userId, enrollmentId, {
      courseId: enrollment.courseId,
      offerCertificate: course.offerCertificate ?? false,
      minCompletionPercent: course.minCompletionPercent ?? 80,
      minQuizScorePercent: course.minQuizScorePercent ?? 0,
    });
    if (!eligibility?.eligible) return eligibility;

    await CertificateQueueService.getInstance().queueCertificate({
      userId,
      courseId: enrollment.courseId,
      enrollmentId,
      completionPercent: eligibility.completionPercent,
      /* @info - The certificate row is NOT NULL on this column and nothing
       * gates on it, so a null (no quizzes attempted) is stored as 100. */
      quizScorePercent: eligibility.quizScorePercent ?? 100,
    });

    return eligibility;
  };

  /**
   * @info - Gathers the plain data the pure eligibility rules need and runs
   *         them. Public so the progress endpoint can explain a decision
   *         without duplicating any of the queries.
   */
  evaluateEligibility = async (
    userId: number,
    enrollmentId: number,
    criteria?: {
      courseId: number;
      offerCertificate: boolean;
      minCompletionPercent: number;
      minQuizScorePercent: number;
    },
  ): Promise<CertificateEligibilityResult | null> => {
    const db = getDb();

    const resolved =
      criteria ?? (await this._certificateCriteria(enrollmentId));
    if (!resolved) return null;

    /* @info - Published lessons only: drafts cannot be required of a student,
     * and a completion recorded against one cannot count towards the
     * threshold. */
    const lessonRows = await db
      .select({ id: lessons.id, type: lessons.type, title: lessons.title })
      .from(lessons)
      .innerJoin(modules, eq(modules.id, lessons.moduleId))
      .where(
        and(
          eq(modules.courseId, resolved.courseId),
          ne(lessons.status, LessonStatus.DRAFT as any),
        ),
      );

    const progressRows = await this.progress.findByEnrollment(enrollmentId);

    return evaluateCertificateEligibility({
      offerCertificate: resolved.offerCertificate,
      minCompletionPercent: resolved.minCompletionPercent,
      minQuizScorePercent: resolved.minQuizScorePercent,
      publishedLessonIds: lessonRows.map((lesson) => lesson.id),
      completedLessonIds: progressRows
        .filter((row: any) => row.completed)
        .map((row: any) => row.lessonId),
      quizLessons: await this._quizInputs(
        userId,
        lessonRows.filter((lesson) => lesson.type === "quiz"),
      ),
    });
  };

  /** @info - The course's certificate settings, resolved from an enrollment. */
  private _certificateCriteria = async (enrollmentId: number) => {
    const db = getDb();
    const [enrollment] = await db
      .select({ courseId: enrollmentsModel.courseId })
      .from(enrollmentsModel)
      .where(eq(enrollmentsModel.id, enrollmentId))
      .limit(1);
    if (!enrollment) return null;

    const [course] = await db
      .select({
        offerCertificate: courses.offerCertificate,
        minCompletionPercent: courses.minCompletionPercent,
        minQuizScorePercent: courses.minQuizScorePercent,
      })
      .from(courses)
      .where(eq(courses.id, enrollment.courseId))
      .limit(1);
    if (!course) return null;

    return {
      courseId: enrollment.courseId,
      offerCertificate: course.offerCertificate ?? false,
      minCompletionPercent: course.minCompletionPercent ?? 80,
      minQuizScorePercent: course.minQuizScorePercent ?? 0,
    };
  };

  /**
   * @info - Per-quiz attempt data. Two counts per quiz lesson: the questions
   *         that exist (the score denominator, so unanswered questions count
   *         against the student) and the ones currently answered correctly.
   *         Note `quiz_attempts` holds ONE row per question, upserted on
   *         re-submission, so these are current standings rather than a
   *         history of every attempt.
   */
  private _quizInputs = async (
    userId: number,
    quizLessons: Array<{ id: number; title: string | null }>,
  ): Promise<CertificateQuizInput[]> => {
    const db = getDb();
    const inputs: CertificateQuizInput[] = [];

    for (const lesson of quizLessons) {
      const [authored] = await db
        .select({ total: count() })
        .from(quizQuestions)
        .where(eq(quizQuestions.lessonId, lesson.id));
      const [correct] = await db
        .select({ total: count() })
        .from(quizAttempts)
        .where(
          and(
            eq(quizAttempts.userId, userId),
            eq(quizAttempts.lessonId, lesson.id),
            eq(quizAttempts.isCorrect, true),
          ),
        );
      const [attempted] = await db
        .select({ total: count() })
        .from(quizAttempts)
        .where(
          and(
            eq(quizAttempts.userId, userId),
            eq(quizAttempts.lessonId, lesson.id),
          ),
        );

      inputs.push({
        lessonId: lesson.id,
        title: lesson.title?.trim() || "Quiz",
        totalQuestions: Number(authored?.total ?? 0),
        correctAnswers: Number(correct?.total ?? 0),
        attempted: Number(attempted?.total ?? 0) > 0,
      });
    }

    return inputs;
  };

  /**
   * @info - Lesson progress plus the certificate verdict, for the learn page.
   *         Attached here rather than behind a new endpoint so the learner's
   *         checklist costs no extra round trip.
   */
  getLessonProgress = async (authData: IAuthData, enrollmentId: number) => {
    const data = await this.progress.findByEnrollment(enrollmentId);

    let eligibility: CertificateEligibilityResult | null = null;
    try {
      eligibility = await this.evaluateEligibility(
        Number(authData.id),
        enrollmentId,
      );
    } catch (e) {
      this.log.error("Could not evaluate certificate eligibility", {
        error: e,
        enrollmentId,
      });
    }

    return { data, eligibility };
  };
}
