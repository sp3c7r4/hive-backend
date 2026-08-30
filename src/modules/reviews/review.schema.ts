import { z } from "zod";

export const createReviewSchema = z.object({
	courseId: z.number().int().positive(),
	rating: z.number().int().min(1).max(5),
	title: z.string().max(255).optional(),
	comment: z.string().min(1).max(2000),
});
