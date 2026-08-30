import { z } from "zod";
import { CourseDifficulty, CourseVisibility, LessonType } from "@/enums";

const coerceBool = (val: unknown) => {
	if (typeof val === "string") return val === "true" || val === "1";
	return val;
};

const coerceInt = (val: unknown) => {
	if (typeof val === "string") {
		const n = Number(val);
		return Number.isNaN(n) ? val : n;
	}
	return val;
};

export const createCourseSchema = z.object({
	communityId: z.number().int(),
	title: z.string().min(1).max(255),
	subtitle: z.string().max(500).optional(),
	description: z.string().optional(),
	category: z.string().max(255).optional(),
	difficulty: z.nativeEnum(CourseDifficulty).optional(),
	visibility: z.nativeEnum(CourseVisibility).optional(),
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

/** @info - FormData variant: all fields are strings, booleans/ints need coercion */
export const createCourseFormSchema = z.object({
	communityId: z.preprocess(coerceInt, z.number().int()),
	title: z.string().min(1).max(255),
	subtitle: z.string().max(500).optional(),
	description: z.string().optional(),
	category: z.string().max(255).optional(),
	difficulty: z.nativeEnum(CourseDifficulty).optional(),
	visibility: z.nativeEnum(CourseVisibility).optional(),
	price: z.preprocess(coerceInt, z.number().int().optional()),
	isFree: z.preprocess(coerceBool, z.boolean().optional()),
	sequentialAccess: z.preprocess(coerceBool, z.boolean().optional()),
	dripContent: z.preprocess(coerceBool, z.boolean().optional()),
	offerCertificate: z.preprocess(coerceBool, z.boolean().optional()),
	minCompletionPercent: z.preprocess(coerceInt, z.number().int().min(0).max(100).optional()),
	minQuizScorePercent: z.preprocess(coerceInt, z.number().int().min(0).max(100).optional()),
	minAttendancePercent: z.preprocess(coerceInt, z.number().int().min(0).max(100).optional()),
});

export const createModuleSchema = z.object({
	title: z.string().min(1).max(255),
	description: z.string().optional(),
	sortOrder: z.number().int().default(0),
});

export const createLessonSchema = z.object({
	title: z.string().min(1).max(255),
	description: z.string().optional(),
	type: z.nativeEnum(LessonType).default(LessonType.VIDEO),
	duration: z.string().max(100).optional(),
	sortOrder: z.number().int().default(0),
	freePreview: z.boolean().optional(),
	randomizeQuestions: z.boolean().optional(),
	videoUrl: z.string().max(1000).optional(),
	pdfUrl: z.string().max(1000).optional(),
	liveMeetingLink: z.string().max(1000).optional(),
	liveMeetingDate: z.string().max(255).optional(),
	attachmentUrl: z.string().max(1000).optional(),
});

export const updateCourseSchema = createCourseSchema.partial();
export const updateModuleSchema = createModuleSchema.partial();
export const updateLessonSchema = createLessonSchema.partial();

export const generateMeetingSchema = z.object({
	provider: z.enum(["google", "zoom"]),
	summary: z.string().min(1),
	description: z.string().optional(),
	startTime: z.string().min(1),
	endTime: z.string().min(1),
	attendees: z.array(z.object({
		entityId: z.number().int(),
		entityType: z.string(),
	})).optional(),
	duration: z.number().int().optional(),
	autoRecord: z.boolean().optional(),
});
