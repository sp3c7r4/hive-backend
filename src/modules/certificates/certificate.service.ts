import { eq } from "drizzle-orm";
import { throwBadRequestError } from "@/helpers/errors/throw-errors";
import { serviceLogger } from "@/utils";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { CertificateMessages } from "./certificate.message";
import { CertificateRepository } from "./certificate.repository";

export class CertificateService {
	private static instance: CertificateService;
	private repo: CertificateRepository;

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

		return this.repo.create({
			userId: authData.id,
			courseId,
			enrollmentId,
			code,
			completionPercent,
			quizScorePercent,
			attendancePercent,
		} as any);
	};

	verify = async (code: string) => {
		const cert = await this.repo.findByCode(code);
		if (!cert) return null;

		return {
			code: cert.code,
			issuedAt: cert.issuedAt,
			completionPercent: cert.completionPercent,
			quizScorePercent: cert.quizScorePercent,
			attendancePercent: cert.attendancePercent,
		};
	};

	getUserCertificates = async (authData: IAuthData) => {
		return this.repo.findMany(
			eq(this.repo.getModel().userId as any, authData.id),
		);
	};

	private _generateCode = (userId: number, courseId: number): string => {
		const ts = Date.now().toString(36);
		const uid = userId.toString(36);
		const cid = courseId.toString(36);
		return `HIVE-${uid}-${cid}-${ts}`.toUpperCase();
	};
}
