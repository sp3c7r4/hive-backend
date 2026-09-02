import { BaseQueueService } from "@/bases/services/base.queue.service";
import { JobNames, QueueNames } from "@/enums";

export interface CertificateJobData {
	userId: number;
	courseId: number;
	enrollmentId: number;
	completionPercent: number;
	quizScorePercent: number;
	attendancePercent?: number;
	idempotencyKey: string;
}

export class CertificateQueueService extends BaseQueueService<CertificateJobData> {
	private static instance: CertificateQueueService;

	private constructor() {
		super({
			queueName: QueueNames.CERTIFICATE,
			alias: "Certificate",
			args: {}, // no priority - prioritized jobs stuck in prod
		});
	}

	static getInstance(): CertificateQueueService {
		if (!this.instance) {
			this.instance = new CertificateQueueService();
		}
		return this.instance;
	}

	/** @info - Enqueue certificate generation; idempotent per user+course. */
	queueCertificate = async (data: Omit<CertificateJobData, "idempotencyKey">) => {
		return this.add(JobNames.GENERATE_CERTIFICATE, {
			...data,
			idempotencyKey: `certificate:${data.courseId}:${data.userId}`,
		});
	};
}
