import { z } from "zod";

export const quizSubmissionSchema = z.object({
	lessonId: z.number().int(),
	answers: z.array(
		z.object({
			questionId: z.number().int(),
			selectedAnswer: z.string(),
		}),
	).min(1, "At least one answer is required"),
});
