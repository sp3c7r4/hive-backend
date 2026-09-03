/**
 * @info - Live course builder: DeepSeek drafts a full course structure that
 * streams into the instructor's create form as it generates. Strict-HTML
 * prose rules are enforced by the system prompt AND the client-side
 * normalizeAssistantHtml sanitizer; this module only produces drafts,
 * never persists them (save happens through the existing course APIs).
 */
import { z } from "zod";

/** @info - Shared strict-HTML prose field; must stay in sync with
 * hive/src/lib/schemas/course-draft.ts (frontend mirror) */
const strictHtml = z
	.string()
	.describe(
		"STRICT HTML using only <p>, <br>, <b>, <i>, <ul>, <ol>, <li>. No attributes, headings, links, images, scripts, markdown, or raw newlines.",
	);

const quizQuestionSchema = z.object({
	question: z.string().min(1).max(500),
	options: z.array(z.string().min(1)).min(2).max(5),
	correctAnswer: z.string().min(1).max(500),
	explanation: strictHtml.optional(),
});

const rubricCriterionSchema = z.object({
	criterion: z.string().min(1).max(255),
	points: z.number().int().min(0).max(100),
});

const lessonSchema = z.object({
	title: z.string().min(1).max(255),
	type: z.enum(["text", "quiz", "assignment"]),
	content: strictHtml.optional(),
	quiz: z.array(quizQuestionSchema).min(1).optional(),
	rubric: z.array(rubricCriterionSchema).min(1).optional(),
});

const moduleSchema = z.object({
	title: z.string().min(1).max(255),
	description: strictHtml.optional(),
	lessons: z.array(lessonSchema).min(1),
});

/** @info - The whole draft. Mirrored client-side for useObject typing. */
export const courseDraftSchema = z.object({
	title: z.string().min(1).max(255),
	subtitle: z.string().max(500).optional(),
	description: strictHtml.optional(),
	category: z.string().max(255).optional(),
	modules: z.array(moduleSchema).min(1),
});

/** @info - Single-module schema for the regenerate endpoint */
export const courseModuleSchema = moduleSchema;

export const draftSyllabusSchema = z.object({
	syllabus: z.string().min(20).max(20_000),
});

export const moduleRegenerateSchema = z.object({
	courseTitle: z.string().min(1).max(255),
	otherModuleTitles: z.array(z.string().min(1)).max(30),
	currentModule: courseModuleSchema,
});

export type CourseDraft = z.infer<typeof courseDraftSchema>;
export type CourseModule = z.infer<typeof courseModuleSchema>;
export type QuizQuestionDraft = z.infer<typeof quizQuestionSchema>;
export type RubricCriterionDraft = z.infer<typeof rubricCriterionSchema>;
