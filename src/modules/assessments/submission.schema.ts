import { z } from "zod";

export const submitAssignmentSchema = z.object({
	lessonId: z.coerce.number().int(),
	text: z.string().optional(),
});

export const gradeSubmissionSchema = z.object({
	score: z.number().int().min(0),
	feedback: z.string().optional(),
	action: z.enum(["grade", "return_for_revision"]),
});

export const assignmentSettingsSchema = z.object({
	instructions: z.string().optional(),
	dueDate: z.string().optional(),
	maxScore: z.number().int().min(0).optional(),
	submissionType: z.string().optional(),
	rubric: z.record(z.string(), z.any()).optional(),
});
