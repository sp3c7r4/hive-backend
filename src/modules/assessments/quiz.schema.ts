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
	lessonId: z.number().int(),
	type: z.enum(Object.values(QuizQuestionType) as [string, ...string[]]).default("multiple"),
	text: z.string().min(1),
	options: z.array(z.string()).optional(),
	correctAnswer: z.string().min(1),
	explanation: z.string().optional(),
	points: z.number().int().default(1),
	sortOrder: z.number().int().default(0),
});

export const updateQuizQuestionSchema = createQuizQuestionSchema.omit({ lessonId: true }).partial();
