import { z } from "zod";
import { CommunityVisibility } from "@/enums";

const coerceBool = (val: unknown) => {
	if (typeof val === "string") {
		if (val === "true") return true;
		if (val === "false") return false;
	}
	return val;
};

const coerceInt = (val: unknown) => {
	if (typeof val === "string" && val !== "") return Number(val);
	return val;
};

export const createCommunitySchema = z.object({
	name: z.string().min(1).max(255),
	description: z.string().optional(),
	category: z.string().max(255).optional(),
	visibility: z.nativeEnum(CommunityVisibility).optional(),
	requiresApproval: z.boolean().optional(),
	isPaid: z.boolean().optional(),
	price: z.number().int().optional(),
	coverImageUrl: z.string().max(500).optional(),
	sequentialCourses: z.boolean().optional(),
	allowDownloads: z.boolean().optional(),
	maxConcurrentDevices: z.number().int().optional(),
	gracePeriodDays: z.number().int().optional(),
});

/** @info - FormData variant: all fields are strings, booleans/ints need coercion */
export const createCommunityFormSchema = z.object({
	name: z.string().min(1).max(255),
	description: z.string().optional(),
	category: z.string().max(255).optional(),
	visibility: z.nativeEnum(CommunityVisibility).optional(),
	requiresApproval: z.preprocess(coerceBool, z.boolean().optional()),
	isPaid: z.preprocess(coerceBool, z.boolean().optional()),
	price: z.preprocess(coerceInt, z.number().int().optional()),
});

export const updateCommunitySchema = createCommunitySchema.partial();
