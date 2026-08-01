import { z } from "zod";

export const instructorStatsQuerySchema = z.object({
	from: z.string().optional(),
	to: z.string().optional(),
});

export const liveClassesQuerySchema = z.object({
	page: z.coerce.number().optional().default(1),
	limit: z.coerce.number().optional().default(5),
	filter: z.enum(["upcoming", "past"]).optional(),
});
