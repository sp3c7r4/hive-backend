import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { IdempotentWorkerService } from "@/bases";
import { QueueNames, JobNames } from "@/enums";
import { logger } from "@/utils";
import { getDb } from "@/db/postgres.db";
import { config } from "@/config";
import { users } from "@/modules/user/user.model";
import { instructorProfiles } from "@/modules/instructor/instructor.model";
import { courses } from "@/modules/courses/course.model";
import { certificates } from "@/modules/certificates/certificate.model";
import { CertificateService } from "@/modules/certificates/certificate.service";
import { CertificateSettingsService } from "@/modules/admin/certificate-settings.service";
import { NotificationService } from "@/modules/notifications";
import { NotificationType } from "@/enums";
import { CertificateGenerator, type CertificateTemplateData } from "../certificate.generator.service";
import { StorageService } from "../storage.service";

export interface CertificateWorkerJobData {
	userId: number;
	courseId: number;
	enrollmentId: number;
	completionPercent: number;
	quizScorePercent: number;
	attendancePercent?: number;
	idempotencyKey: string;
}

/** @info - Consumes CertificateGenerationQueue: validates + issues the
 * certificate row, renders the Handlebars template to a landscape PDF,
 * uploads it to S3 (certificates/<code>.pdf) and stores the URL. */
export class CertificateWorkerService extends IdempotentWorkerService<CertificateWorkerJobData> {
	private static instance: CertificateWorkerService;

	static getInstance() {
		if (!this.instance) {
			this.instance = new CertificateWorkerService();
		}
		return this.instance;
	}

	private constructor(concurrency = 5) {
		super({
			queueName: QueueNames.CERTIFICATE,
			alias: "CertificateWorker",
			concurrency,
		});
	}

	protected async idempotentProcess(job: Job<CertificateWorkerJobData>) {
		const { userId, courseId, enrollmentId, completionPercent, quizScorePercent } = job.data;
		const db = getDb();

		const [user] = await db
			.select({ firstName: users.firstName, lastName: users.lastName, email: users.email })
			.from(users)
			.where(eq(users.id, userId))
			.limit(1);
		const [course] = await db
			.select({
				title: courses.title,
				courseLevel: courses.difficulty,
				category: courses.category,
				instructorId: courses.instructorId,
				communityId: courses.communityId,
				minCompletion: courses.minCompletionPercent,
				minQuiz: courses.minQuizScorePercent,
				allowCertificate: courses.offerCertificate,
			})
			.from(courses)
			.where(eq(courses.id, courseId))
			.limit(1);
		if (!user || !course) throw new Error(`Missing user/course for certificate job ${job.id}`);

		/* Course instructor (+ their uploaded signature) */
		const [instructor] = await db
			.select({
				firstName: users.firstName,
				lastName: users.lastName,
				signatureUrl: instructorProfiles.signatureUrl,
			})
			.from(users)
			.leftJoin(instructorProfiles, eq(instructorProfiles.userId, users.id))
			.where(eq(users.id, course.instructorId))
			.limit(1);
		/* Issue (idempotent — returns the existing row + skips re-emailing) */
		const certificate = await CertificateService.getInstance().issue(
			{
				id: userId,
				email: user.email ?? "",
				firstName: user.firstName ?? "",
				lastName: user.lastName ?? "",
				roles: [],
			} as any,
			{
				courseId,
				enrollmentId,
				completionPercent,
				quizScorePercent,
				attendancePercent: job.data.attendancePercent ?? 100,
				minCompletion: course.minCompletion ?? 0,
				minQuiz: course.minQuiz ?? 0,
				minAttendance: 0,
				allowCertificate: course.allowCertificate ?? false,
			},
		);

		/* Already generated? Nothing to do (idempotency) */
		if (certificate.fileUrl) {
			logger.info(`Certificate ${certificate.code} already generated`, { jobId: job.id });
			return;
		}

		const completionDate = new Date(certificate.issuedAt).toLocaleDateString("en-US", {
			year: "numeric",
			month: "long",
			day: "numeric",
		});

		/* @info - Director block: platform_settings wins, env is the fallback */
		const director = await CertificateSettingsService.getInstance().get();

		const htmlData: CertificateTemplateData = {
			studentName: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim(),
			course: course.title ?? "Course",
			certificateId: certificate.code,
			issuedDate: completionDate,
			courseInstructorName:
				`${instructor?.firstName ?? ""} ${instructor?.lastName ?? ""}`.trim() ||
				"Course Instructor",
			courseInstructorSignature:
				instructor?.signatureUrl?.trim() || undefined,
			executiveDirectorName: director.directorName,
			executiveDirectorSignature:
				director.directorSignature?.trim() || undefined,
		};

		/* @info - Certificates are images: render the template to a crisp PNG */
		const image = await CertificateGenerator.getInstance().generateImage(htmlData);

		const key = `certificates/${certificate.code}.png`;
		await StorageService.getInstance().upload({
			key,
			body: image,
			contentType: "image/png",
		});

		await db
			.update(certificates)
			.set({ fileUrl: key })
			.where(eq(certificates.code, certificate.code));

		/* @info - Tell the student their certificate is ready */
		NotificationService.getInstance().notify(
			userId,
			NotificationType.CERTIFICATE,
			"Certificate ready",
			`Your certificate for ${course.title ?? "the course"} is ready to view`,
			{ certificateCode: certificate.code, courseId },
		);

		logger.info(`Certificate ${certificate.code} generated + uploaded`, { jobId: job.id });
	}
}
