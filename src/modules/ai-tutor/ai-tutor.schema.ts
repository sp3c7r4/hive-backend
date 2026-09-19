import { z } from "zod";

export const tutorChatParamsSchema = z.object({
	courseId: z.coerce.number().int().positive("Invalid course id."),
});

export const tutorChatSchema = z.object({
	/** @info - Current lesson id (progress gate): null = no lesson open */
	lessonId: z.coerce.number().int().positive().optional(),
	/* @info - Length is not a quality bar: "Hi", "why?" and "?" are
	 * legitimate questions and the composer already refuses empty input. Only
	 * emptiness is rejected here, and only because this is the API boundary. */
	question: z
		.string()
		.trim()
		.min(1, "Ask a question first.")
		.max(1000, "Question is too long."),
});

export type TutorChatInput = z.infer<typeof tutorChatSchema>;
