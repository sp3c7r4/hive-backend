import z from "zod";

export * from "./auth.schema";

export const positiveInt = z.coerce.number().int().positive();

export const businessIdSchema = z.object({
	businessId: positiveInt,
});

export const querySchema = z.object({
	page: z.coerce.number().optional(),
	limit: z.coerce.number().optional(),
	filter: z.object(z.any()).optional(),
});
