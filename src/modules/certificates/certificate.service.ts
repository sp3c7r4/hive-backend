import { eq } from "drizzle-orm";
import { throwBadRequestError } from "@/helpers/errors/throw-errors";
import { withPresignedUrl } from "@/helpers/storage.helper";
import { serviceLogger } from "@/utils";
import { config } from "@/config";
import { getDb } from "@/db/postgres.db";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { EmailJobNames } from "@/enums";
import { EmailQueueService } from "@/services/queues/email.queue.service";
import { CertificateMessages } from "./certificate.message";
import { CertificateRepository } from "./certificate.repository";
import { courses } from "@/modules/courses/course.model";
import { users } from "@/modules/user/user.model";

export class CertificateService {
	private static instance: CertificateService;
	private repo: CertificateRepository;
	private readonly emailQueue = EmailQueueService.getInstance();

	/** @info - Utilities */
	private readonly log = serviceLogger("Certificate");

	static getInstance(): CertificateService {
		if (!this.instance) this.instance = new CertificateService();
		return this.instance;
	}

	private constructor() {
		this.repo = CertificateRepository.getInstance();
	}

	issue = async (authData: IAuthData, params: {
		courseId: number;
		enrollmentId: number;
		completionPercent: number;
		quizScorePercent: number;
		attendancePercent: number;
		minCompletion: number;
		minQuiz: number;
		minAttendance: number;
		allowCertificate: boolean;
	}) => {
		const {
			courseId,
			enrollmentId,
			completionPercent,
			quizScorePercent,
			attendancePercent,
			minCompletion,
			minQuiz,
			minAttendance,
			allowCertificate,
		} = params;

		if (!allowCertificate) {
			throwBadRequestError(CertificateMessages.NO_CERTIFICATE);
		}

		/* Check if already issued */
		const existing = await this.repo.findByUserAndCourse(authData.id, courseId);
		if (existing) return existing;

		/* Validate requirements */
		if (completionPercent < minCompletion) {
			throwBadRequestError(
				CertificateMessages.COMPLETION_BELOW(completionPercent, minCompletion),
			);
		}
		if (quizScorePercent < minQuiz) {
			throwBadRequestError(
				CertificateMessages.QUIZ_BELOW(quizScorePercent, minQuiz),
			);
		}
		if (attendancePercent < minAttendance) {
			throwBadRequestError(
				CertificateMessages.ATTENDANCE_BELOW(attendancePercent, minAttendance),
			);
		}

		const code = this._generateCode(authData.id, courseId);

		const certificate = await this.repo.create({
			userId: authData.id,
			courseId,
			enrollmentId,
			code,
			completionPercent,
			quizScorePercent,
			attendancePercent,
		} as any);

		/* Queue certificate-issued email */
		const db = getDb();
		const [courseRow] = await db
			.select({ title: courses.title })
			.from(courses)
			.where(eq(courses.id, courseId))
			.limit(1);

		this.emailQueue.add(EmailJobNames.CERTIFICATE_ISSUED as any, {
			message: {
				to: authData.email!,
				subject: `Certificate earned for ${courseRow?.title ?? "your course"}!`,
			},
			template: "certificate-issued" as any,
			locals: {
				studentName: authData.firstName ?? "there",
				courseName: courseRow?.title ?? "your course",
				certificateCode: code,
				issuedAt: new Date().toLocaleDateString("en-US", {
					year: "numeric",
					month: "long",
					day: "numeric",
				}),
				dashboardUrl: `${config.server.rootDomain}/dashboard`,
			},
		});

		return certificate;
	};

	verify = async (code: string) => {
		const cert = await this.repo.findByCode(code);
		if (!cert) return null;
		const db = getDb();

		/* @info - Enrich for the public verify page (student + course + instructor) */
		const [course] = await db
			.select({
				title: courses.title,
				instructorId: courses.instructorId,
			})
			.from(courses)
			.where(eq(courses.id, cert.courseId))
			.limit(1);
		const [student] = await db
			.select({ firstName: users.firstName, lastName: users.lastName })
			.from(users)
			.where(eq(users.id, cert.userId))
			.limit(1);
		const [instructor] = course?.instructorId
			? await db
					.select({ firstName: users.firstName, lastName: users.lastName })
					.from(users)
					.where(eq(users.id, course.instructorId))
					.limit(1)
			: [undefined];

		return {
			code: cert.code,
			issuedAt: cert.issuedAt,
			completionPercent: cert.completionPercent,
			quizScorePercent: cert.quizScorePercent,
			attendancePercent: cert.attendancePercent,
			studentName: `${student?.firstName ?? ""} ${student?.lastName ?? ""}`.trim(),
			courseTitle: course?.title ?? "Course",
			instructorName: `${instructor?.firstName ?? ""} ${instructor?.lastName ?? ""}`.trim(),
			fileUrl: cert.fileUrl ? withPresignedUrl(cert as any, "fileUrl").fileUrl : null,
		};
	};

	getUserCertificates = async (authData: IAuthData) => {
		const rows = await this.repo.findMany(
			eq(this.repo.getModel().userId as any, authData.id),
		);
		const db = getDb();
		const enriched = await Promise.all(
			(rows as any[]).map(async (c) => {
				const [course] = await db
					.select({ title: courses.title })
					.from(courses)
					.where(eq(courses.id, c.courseId))
					.limit(1);
				return {
					...c,
					courseTitle: course?.title ?? "Course",
					fileUrl: c.fileUrl ? withPresignedUrl(c, "fileUrl").fileUrl : null,
				};
			}),
		);
		return enriched;
	};

	private _generateCode = (userId: number, courseId: number): string => {
		const ts = Date.now().toString(36);
		const uid = userId.toString(36);
		const cid = courseId.toString(36);
		return `HIVE-${uid}-${cid}-${ts}`.toUpperCase();
	};
}
