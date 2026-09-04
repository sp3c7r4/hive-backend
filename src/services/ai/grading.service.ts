/**
 * @info - Core AI grading logic (services layer, no module imports).
 * Produces SUGGESTIONS only: writes to the ai_* staging fields on the
 * submission and appends an audit row. Nothing here touches score,
 * feedback or gradedAt; approval is the module layer's job.
 *
 * Content resolution (v1.1): typed text, PDF files (unpdf extraction)
 * and image files (JPEG/PNG/GIF/WebP via the DeepSeek vision model).
 * Other file types (docx etc.) are not gradeable and surface a clear
 * refusal. The vision model is an -exp release, so vision failures
 * record a failed run instead of blocking grading.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import { config } from "@/config";
import { logger } from "@/utils";
import { AiService } from "@/services/ai/ai.service";
import { assignmentSubmissions } from "@/modules/assessments/assessment.model";
import { lessons } from "@/modules/courses/course.model";
import { aiGradingLogs } from "@/modules/ai-grading/ai-grading.model";
import { fetchPdfText } from "@/helpers/ai/lesson-content.helper";

/** @info - Real rubric shape: lessons.settings.rubric = [{ criteria, maxPoints }], maxPoints is a string */
export interface RubricCriterion {
	criteria?: string;
	maxPoints?: string;
}

export interface GradingSuggestion {
	score: number;
	feedback: string;
	criterionBreakdown: Array<{
		criterion: string;
		pointsAwarded: number;
		maxPoints: number;
		comment: string;
	}>;
	logId: number;
	/** @info - Which modality produced the suggestion (audit/diagnostics) */
	modality: "text" | "pdf" | "vision";
}

const gradingResultSchema = z.object({
	score: z.number().int().min(0).max(100),
	feedback: z.string(),
	criterionBreakdown: z.array(
		z.object({
			criterion: z.string(),
			pointsAwarded: z.number().min(0),
			maxPoints: z.number().min(0),
			comment: z.string(),
		}),
	),
});

export const IMAGE_MIME: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
};

export function buildGradingPrompt(
	text: string,
	rubric: RubricCriterion[],
	instructorContext?: string,
): string {
	return `
Grade this submission against the rubric below. Return output matching the required schema exactly.

Rubric:
${rubric.map((r) => `- ${r.criteria ?? "Criterion"} (${r.maxPoints ?? "0"} pts)`).join("\n")}

${instructorContext ? `Additional guidance from the instructor for this grading run, apply it alongside the rubric:\n${instructorContext}\n` : ""}

Submission:
${text}
  `.trim();
}

export class GradingService {
	private static instance: GradingService;
	private readonly log = logger;

	static getInstance(): GradingService {
		if (!this.instance) this.instance = new GradingService();
		return this.instance;
	}

	/** @info - Fetch a remote file as base64 (CDN URLs are public). */
	private async fetchBase64(url: string): Promise<string | null> {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
			if (!res.ok) return null;
			const buf = Buffer.from(await res.arrayBuffer());
			return buf.toString("base64");
		} catch {
			return null;
		}
	}

	/** @info - Which files are gradeable and how (pdf -> text, images -> vision) */
	private classifyFiles(fileUrls: string[] | null) {
		const pdfs: string[] = [];
		const images: Array<{ url: string; mediaType: string }> = [];
		for (const url of fileUrls ?? []) {
			const ext = (url.split(".").pop() ?? "").toLowerCase();
			if (ext === "pdf") pdfs.push(url);
			else if (IMAGE_MIME[ext]) images.push({ url, mediaType: IMAGE_MIME[ext] });
		}
		return { pdfs, images };
	}

	/** @info - Resolve the submission content into a gradeable form.
	 * Returns null when there is nothing gradeable. */
	private async resolveContent(submission: {
		text: string | null;
		fileUrls: string[] | null;
	}): Promise<
		| { kind: "text"; text: string; modality: "text" | "pdf" }
		| { kind: "vision"; text: string; images: Array<{ url: string; mediaType: string }>; modality: "vision" }
		| null
	> {
		const { pdfs, images } = this.classifyFiles(submission.fileUrls);

		/* Typed text present: grade the text alone (files optional extra) */
		if (submission.text?.trim()) {
			return { kind: "text", text: submission.text, modality: "text" };
		}

		/* PDF-only: extract text via unpdf (same helper the tutor uses) */
		if (pdfs.length > 0) {
			const pdfText = await fetchPdfText(pdfs[0]!);
			if (pdfText?.trim()) {
				return { kind: "text", text: pdfText, modality: "pdf" };
			}
		}

		/* Image-only: vision model with the raw image(s) */
		if (images.length > 0) {
			const text =
				"This is a photographed or scanned submission. Grade the work shown in the image(s) against the rubric.";
			return { kind: "vision", text, images: images.slice(0, 3), modality: "vision" };
		}

		return null;
	}

	/** @info - Run one AI grading pass. Writes staging fields + audit row.
	 * Returns null when the submission has nothing gradeable, or when the
	 * vision model fails (recorded as a failed run). */
	gradeSubmission = async (
		submissionId: number,
		options?: { instructorContext?: string; batchId?: number },
	): Promise<GradingSuggestion | null> => {
		const db = getDb();
		const [submission] = await db
			.select()
			.from(assignmentSubmissions)
			.where(eq(assignmentSubmissions.id, submissionId))
			.limit(1);
		if (!submission) return null;

		const [lesson] = await db
			.select({ settings: lessons.settings })
			.from(lessons)
			.where(eq(lessons.id, submission!.lessonId))
			.limit(1);
		const settings = (lesson?.settings ?? null) as {
			rubric?: RubricCriterion[];
		} | null;
		const rubric = Array.isArray(settings?.rubric)
			? (settings.rubric as RubricCriterion[])
			: [];

		const content = await this.resolveContent(submission!);
		if (!content) return null;

		const prompt = buildGradingPrompt(
			content.text,
			rubric,
			options?.instructorContext,
		);

		let result;
		if (content.kind === "vision") {
			/* @info - -exp vision model: wrap in try/catch and record a
			 * failed run rather than letting one bad call block a batch. */
			const images = await Promise.all(
				content.images.map(async (img) => {
					const base64 = await this.fetchBase64(img.url);
					return base64 ? { ...img, base64 } : null;
				}),
			);
			const loaded = images.filter(
				(i): i is { url: string; mediaType: string; base64: string } => i !== null,
			);
			if (loaded.length === 0) {
				await this.recordFailure(submissionId, options, "vision");
				return null;
			}

			try {
				result = await generateObject({
					model: AiService.getInstance().visionModel(),
					schema: gradingResultSchema,
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: prompt },
								...loaded.map((img) => ({
									type: "file" as const,
									mediaType: img.mediaType,
									data: { type: "data" as const, data: img.base64 },
								})),
							],
						},
					],
				});
			} catch (e) {
				this.log.error(
					`[Grading] Vision model failed for submission ${submissionId}`,
					e,
				);
				await this.recordFailure(submissionId, options, "vision");
				return null;
			}
		} else {
			try {
				result = await generateObject({
					model: AiService.getInstance().model(),
					schema: gradingResultSchema,
					prompt,
				});
			} catch (e) {
				this.log.error(
					`[Grading] Model failed for submission ${submissionId}`,
					e,
				);
				await this.recordFailure(submissionId, options, content.modality);
				return null;
			}
		}

		const [log] = await db
			.insert(aiGradingLogs)
			.values({
				submissionId,
				batchId: options?.batchId ?? null,
				suggestedScore: result!.object.score,
				suggestedFeedback: result!.object.feedback,
				instructorContext: options?.instructorContext ?? null,
				model:
					content.modality === "vision"
						? config.ai.visionModel
						: config.ai.deepseekModel,
				status: "completed",
			})
			.returning();

		await db
			.update(assignmentSubmissions)
			.set({
				aiSuggestedScore: result!.object.score,
				aiSuggestedFeedback: result!.object.feedback,
				aiSuggestedAt: new Date(),
				aiGraderRunId: log!.id,
			})
			.where(eq(assignmentSubmissions.id, submissionId));

		this.log.info(
			`[Grading] Suggestion for submission ${submissionId} (${content.modality})`,
			{
				score: result!.object.score,
				logId: log!.id,
			},
		);

		return {
			score: result!.object.score,
			feedback: result!.object.feedback,
			criterionBreakdown: result!.object.criterionBreakdown,
			logId: log!.id,
			modality: content.modality,
		};
	};

	/** @info - Record a failed run (no suggestion produced) so the batch
	 * drawer still shows the submission with a failed state. */
	recordFailure = async (
		submissionId: number,
		options?: { instructorContext?: string; batchId?: number },
		reason?: string,
	): Promise<void> => {
		try {
			await getDb()
				.insert(aiGradingLogs)
				.values({
					submissionId,
					batchId: options?.batchId ?? null,
					instructorContext: options?.instructorContext ?? null,
					model:
						reason === "vision"
							? config.ai.visionModel
							: config.ai.deepseekModel,
					status: "failed",
				});
		} catch (e) {
			this.log.error("[Grading] Failed to write failure audit row", e);
		}
	};
}

