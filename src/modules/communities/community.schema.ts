import { z } from "zod";

export const createCommunitySchema = z.object({
	name: z.string().min(1).max(255),
	description: z.string().optional(),
	category: z.string().max(255).optional(),
	visibility: z.enum(["public", "private", "unlisted"]).optional(),
	requiresApproval: z.boolean().optional(),
	isPaid: z.boolean().optional(),
	price: z.number().int().optional(),
	coverImageUrl: z.string().max(500).optional(),
});

export const updateCommunitySchema = createCommunitySchema.partial();
