import { RelationalRepository } from "@/bases";
import { certificates } from "./certificate.model";
import { eq, and } from "drizzle-orm";

export class CertificateRepository extends RelationalRepository<typeof certificates> {
	private static instance: CertificateRepository;

	static getInstance(): CertificateRepository {
		if (!this.instance) this.instance = new CertificateRepository();
		return this.instance;
	}

	private constructor() {
		super(certificates);
	}

	findByUserAndCourse = async (userId: number, courseId: number) => {
		return this.findOne(
			and(
				eq(certificates.userId, userId),
				eq(certificates.courseId, courseId),
			) as any,
		);
	};

	findByCode = async (code: string) => {
		return this.findOne(eq(certificates.code, code));
	};
}
