/**
 * @info - Core AI grading logic (services layer, no module imports).
 * Produces SUGGESTIONS only: writes to the ai_* staging fields on the
 * submission and appends an audit row. Nothing here touches score,
 * feedback or gradedAt; approval is the module layer's job.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import { config } from "@/config";
import { logger } from "@/utils";
import { AiService } from "@/services/ai/ai.service";
import { assignmentSubmissions } from "@/modules/assessments/assessment.model";
import { lessons, modules } from "@/modules/courses/course.model";
import { aiGradingLogs } from "@/modules/ai-grading/ai-grading.model";

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

	/** @info - Rubric + lesson context for a submission (lesson -> module chain) */
	private async getSubmissionWithLessonRubric(submissionId: number) {
		const db = getDb();
		const [submission] = await db
			.select()
			.from(assignmentSubmissions)
			.where(eq(assignmentSubmissions.id, submissionId))
			.limit(1);
		if (!submission || !submission.text) return null;

		const [lesson] = await db
			.select({ settings: lessons.settings, moduleId: lessons.moduleId })
			.from(lessons)
			.where(eq(lessons.id, submission.lessonId))
			.limit(1);

		const settings = (lesson?.settings ?? null) as {
			rubric?: RubricCriterion[];
		} | null;
		const rubric = Array.isArray(settings?.rubric)
			? (settings.rubric as RubricCriterion[])
			: [];

		return { submission, rubric };
	}

	/** @info - Run one AI grading pass. Writes staging fields + audit row.
	 * Returns the suggestion, or null when the submission has no text. */
	gradeSubmission = async (
		submissionId: number,
		options?: { instructorContext?: string; batchId?: number },
	): Promise<GradingSuggestion | null> => {
		const ctx = await this.getSubmissionWithLessonRubric(submissionId);
		if (!ctx) return null;

		const result = await generateObject({
			model: AiService.getInstance().model(),
			schema: gradingResultSchema,
			prompt: buildGradingPrompt(
				ctx.submission.text!,
				ctx.rubric,
				options?.instructorContext,
			),
		});

		const db = getDb();
		const [log] = await db
			.insert(aiGradingLogs)
			.values({
				submissionId,
				batchId: options?.batchId ?? null,
				suggestedScore: result.object.score,
				suggestedFeedback: result.object.feedback,
				instructorContext: options?.instructorContext ?? null,
				model: config.ai.deepseekModel,
				status: "completed",
			})
			.returning();

		await db
			.update(assignmentSubmissions)
			.set({
				aiSuggestedScore: result.object.score,
				aiSuggestedFeedback: result.object.feedback,
				aiSuggestedAt: new Date(),
				aiGraderRunId: log!.id,
			})
			.where(eq(assignmentSubmissions.id, submissionId));

		this.log.info(`[Grading] Suggestion for submission ${submissionId}`, {
			score: result.object.score,
			logId: log!.id,
		});

		return {
			score: result.object.score,
			feedback: result.object.feedback,
			criterionBreakdown: result.object.criterionBreakdown,
			logId: log!.id,
		};
	};

	/** @info - Record a failed run (no suggestion produced) so the batch
	 * drawer still shows the submission with a failed state. */
	recordFailure = async (
		submissionId: number,
		options?: { instructorContext?: string; batchId?: number },
	): Promise<void> => {
		try {
			await getDb()
				.insert(aiGradingLogs)
				.values({
					submissionId,
					batchId: options?.batchId ?? null,
					instructorContext: options?.instructorContext ?? null,
					model: config.ai.deepseekModel,
					status: "failed",
				});
		} catch (e) {
			this.log.error("[Grading] Failed to write failure audit row", e);
		}
	};
}
