import { Templates } from "@/enums";
import { FileGenerator } from "./engine/browser.engine";

/** @info - Data contract for the certificate template (templates/certificate/html.hbs).
 * Everything arrives preformatted — the template never computes dates/percentages. */
export interface CertificateTemplateData {
	studentName: string;
	courseTitle: string;
	instructorName: string;
	issuerName: string;
	completionDate: string;
	certificateId: string;
	verificationUrl: string;
	logoUrl?: string;
	gradeVariant?: "pass" | "distinction";
	courseLevel?: string;
	courseCategory?: string;
	finalProgress?: string;
	quizScore?: string;
	instructorTitle?: string;
	communityName?: string;
}

export class CertificateGenerator extends FileGenerator<CertificateTemplateData> {
	private static instance: CertificateGenerator;

	// templates/certificate/html.hbs — same layout the receipt generator uses.
	protected readonly templatesFolder = "templates";

	private constructor() {
		super();
	}

	static getInstance(): CertificateGenerator {
		if (!this.instance) this.instance = new CertificateGenerator();
		return this.instance;
	}

	protected async buildHtml(options: CertificateTemplateData): Promise<string> {
		const source = await this.getTemplate(Templates.CERTIFICATE);
		return this.compile(source, {
			...options,
			logoUrl: options.logoUrl?.trim() || this.fallbackLogo,
		});
	}
}
