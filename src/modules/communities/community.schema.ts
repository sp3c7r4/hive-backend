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

const baseShape = {
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
};

const formShape = {
	name: z.string().min(1).max(255),
	description: z.string().optional(),
	category: z.string().max(255).optional(),
	visibility: z.nativeEnum(CommunityVisibility).optional(),
	requiresApproval: z.preprocess(coerceBool, z.boolean().optional()),
	isPaid: z.preprocess(coerceBool, z.boolean().optional()),
	price: z.preprocess(coerceInt, z.number().int().optional()),
};

const noPaidAndApproval: { message: string; path: PropertyKey[] } = {
	message: "A community cannot be both paid and require approval (refunds are not wired yet)",
	path: ["isPaid"],
};

export const createCommunitySchema = z.object(baseShape).refine((d) => !(d.isPaid && d.requiresApproval), noPaidAndApproval);

/** @info - FormData variant: all fields are strings, booleans/ints need coercion */
export const createCommunityFormSchema = z.object(formShape).refine((d) => !(d.isPaid && d.requiresApproval), noPaidAndApproval);

export const updateCommunitySchema = z
	.object(baseShape)
	.partial()
	.refine((d) => !(d.isPaid && d.requiresApproval), noPaidAndApproval);
