import { CertificateRepository } from "./certificate.repository";

export class CertificateService {
	private static instance: CertificateService;

	private readonly repo: CertificateRepository;

	static getInstance(): CertificateService {
		if (!this.instance) this.instance = new CertificateService();
		return this.instance;
	}

	private constructor() {
		this.repo = CertificateRepository.getInstance();
	}

	/**
	 * @info - Issue a certificate if the student meets course requirements.
	 * If already issued, return the existing certificate.
	 */
	issue = async (params: {
		userId: number;
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
			userId,
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
			throw new Error("This course does not offer certificates");
		}

		/** @info - Check if already issued */
		const existing = await this.repo.findByUserAndCourse(userId, courseId);
		if (existing) return existing;

		/** @info - Validate requirements */
		if (completionPercent < minCompletion) {
			throw new Error(
				`Completion ${completionPercent}% is below required ${minCompletion}%`,
			);
		}
		if (quizScorePercent < minQuiz) {
			throw new Error(
				`Quiz score ${quizScorePercent}% is below required ${minQuiz}%`,
			);
		}
		if (attendancePercent < minAttendance) {
			throw new Error(
				`Attendance ${attendancePercent}% is below required ${minAttendance}%`,
			);
		}

		/** @info - Generate verification code */
		const code = this._generateCode(userId, courseId);

		return this.repo.create({
			userId,
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

		/** @info - Return minimal public verification info */
		return {
			code: cert.code,
			issuedAt: cert.issuedAt,
			completionPercent: cert.completionPercent,
			quizScorePercent: cert.quizScorePercent,
			attendancePercent: cert.attendancePercent,
		};
	};

	getUserCertificates = async (userId: number) => {
		return this.repo.findMany(
			eq(this.repo.getModel().userId as any, userId),
		);
	};

	private _generateCode = (userId: number, courseId: number): string => {
		const ts = Date.now().toString(36);
		const uid = userId.toString(36);
		const cid = courseId.toString(36);
		return `HIVE-${uid}-${cid}-${ts}`.toUpperCase();
	};
}
