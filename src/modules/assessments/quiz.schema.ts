import { z } from "zod";
import { QuizQuestionType } from "@/enums";

export const quizSubmissionSchema = z.object({
	lessonId: z.number().int(),
	answers: z.array(
		z.object({
			questionId: z.number().int(),
			selectedAnswer: z.string(),
		}),
	).min(1, "At least one answer is required"),
});

export const createQuizQuestionSchema = z.object({
	/** @info - Optional: the controller injects it from the URL param */
	lessonId: z.number().int().optional(),
	type: z.enum(Object.values(QuizQuestionType) as [string, ...string[]]).default("multiple"),
	text: z.string().min(1),
	options: z.array(z.string()).optional(),
	correctAnswer: z.string().min(1),
	explanation: z.string().optional(),
	points: z.number().int().default(1),
	sortOrder: z.number().int().default(0),
});

export const updateQuizQuestionSchema = createQuizQuestionSchema.omit({ lessonId: true }).partial();

/**
 * @info - Autosave writes one answer at a time, so it carries only the question
 *         being answered. `lessonId` rather than a path param because the client
 *         already has it from the session call, and the pair is what the
 *         once-only rule is enforced against.
 */
export const assessmentAutosaveSchema = z.object({
	lessonId: z.number().int(),
	questionId: z.number().int(),
	selectedAnswer: z.string().max(500),
});
