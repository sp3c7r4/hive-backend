import { z } from "zod";

export const createCourseSchema = z.object({
	communityId: z.number().int(),
	title: z.string().min(1).max(255),
	subtitle: z.string().max(500).optional(),
	description: z.string().optional(),
	category: z.string().max(255).optional(),
	difficulty: z.enum(["beginner", "intermediate", "advanced"]).optional(),
	visibility: z.enum(["public", "private", "unlisted"]).optional(),
	price: z.number().int().default(0),
	isFree: z.boolean().optional(),
	sequentialAccess: z.boolean().optional(),
	dripContent: z.boolean().optional(),
	offerCertificate: z.boolean().optional(),
	minCompletionPercent: z.number().int().min(0).max(100).optional(),
	minQuizScorePercent: z.number().int().min(0).max(100).optional(),
	minAttendancePercent: z.number().int().min(0).max(100).optional(),
	coverImageUrl: z.string().max(500).optional(),
});

export const createModuleSchema = z.object({
	title: z.string().min(1).max(255),
	description: z.string().optional(),
	sortOrder: z.number().int().default(0),
});

export const createLessonSchema = z.object({
	title: z.string().min(1).max(255),
	description: z.string().optional(),
	type: z.enum(["video", "pdf", "live", "quiz", "assignment"]).default("video"),
	duration: z.string().max(100).optional(),
	sortOrder: z.number().int().default(0),
	freePreview: z.boolean().optional(),
	videoUrl: z.string().max(1000).optional(),
	pdfUrl: z.string().max(1000).optional(),
	liveMeetingLink: z.string().max(1000).optional(),
	liveMeetingDate: z.string().max(255).optional(),
	attachmentUrl: z.string().max(1000).optional(),
});

export const updateCourseSchema = createCourseSchema.partial();
export const updateModuleSchema = createModuleSchema.partial();
export const updateLessonSchema = createLessonSchema.partial();
