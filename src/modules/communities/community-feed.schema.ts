import { z } from "zod";

export const createPostSchema = z.object({
	content: z.string().min(1).max(15000),
	isAnnouncement: z.boolean().optional(),
	attachments: z
		.array(
			z.object({
				filename: z.string().min(1).max(500),
				s3Key: z.string().min(1).max(1000),
			}),
		)
		.max(10)
		.optional(),
});

export const updatePostSchema = z.object({
	content: z.string().min(1).max(15000).optional(),
	isPinned: z.boolean().optional(),
	isAnnouncement: z.boolean().optional(),
});

export const createCommentSchema = z.object({
	content: z.string().min(1).max(2000),
	parentId: z.number().int().positive().optional(),
});

export const updateCommentSchema = z.object({
	content: z.string().min(1).max(2000),
});
