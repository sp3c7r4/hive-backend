import { z } from "zod";

export const tutorChatParamsSchema = z.object({
	courseId: z.coerce.number().int().positive("Invalid course id."),
});

export const tutorChatSchema = z.object({
	/** @info - Current lesson id (progress gate): null = no lesson open */
	lessonId: z.coerce.number().int().positive().optional(),
	question: z.string().trim().min(3, "Question is too short.").max(1000, "Question is too long."),
});

export type TutorChatInput = z.infer<typeof tutorChatSchema>;
