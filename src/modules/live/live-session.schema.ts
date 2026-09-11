import { z } from "zod";
import { LiveSessionKind } from "@/enums";

/**
 * @info - Body shapes for the standalone-event endpoints (phase 2). These validate
 * shape only: rules that depend on the session itself - the kind being immutable, a
 * link versus a Hive room, who may act - belong to the service, where the row is
 * known.
 */
export const createLiveSessionSchema = z.object({
	kind: z.nativeEnum(LiveSessionKind),
	title: z.string().trim().min(1).max(255),
	description: z.string().max(5000).nullish(),
	startsAt: z.string().min(1).nullish(),
	durationMinutes: z
		.number()
		.int()
		.min(5)
		.max(24 * 60)
		.optional(),
	meetingUrl: z.string().max(1000).nullish(),
});

export const updateLiveSessionSchema = z.object({
	kind: z.nativeEnum(LiveSessionKind).optional(),
	title: z.string().trim().min(1).max(255).optional(),
	description: z.string().max(5000).nullish(),
	startsAt: z.string().nullish(),
	durationMinutes: z
		.number()
		.int()
		.min(5)
		.max(24 * 60)
		.optional(),
	meetingUrl: z.string().max(1000).nullish(),
});
