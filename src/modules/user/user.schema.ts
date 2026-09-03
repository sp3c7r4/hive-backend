import { z } from "zod";

export const onboardUserSchema = z.object({
	bio: z.string().optional(),

	specializationTags: z.preprocess(
		(val) => {
			if (typeof val === "string") {
				try { return JSON.parse(val); } catch { return val; }
			}
			return val;
		},
		z.array(z.string()).optional(),
	),

	interestTags: z.preprocess(
		(val) => {
			if (typeof val === "string") {
				try { return JSON.parse(val); } catch { return val; }
			}
			return val;
		},
		z.array(z.string()).optional(),
	),

	notifications: z.preprocess(
		(val) => {
			if (typeof val === "string") {
				try { return JSON.parse(val); } catch { return val; }
			}
			return val;
		},
		z
			.object({
				email: z.boolean().optional(),
				sms: z.boolean().optional(),
				whatsapp: z.boolean().optional(),
				push: z.boolean().optional(),
			})
			.optional(),
	),

	childEmail: z.string().email().optional(),
});

export const updateUserSchema = z.object({
	firstName: z.string().min(1).optional(),
	lastName: z.string().max(255).optional(),
	phone: z.string().optional(),
	bio: z.string().optional(),
	preferences: z
		.object({
			notifications: z
				.object({
					email: z.boolean().optional(),
					sms: z.boolean().optional(),
					whatsapp: z.boolean().optional(),
					push: z.boolean().optional(),
				})
				.optional(),
		})
		.optional(),
});

export const changePasswordSchema = z.object({
	currentPassword: z.string().min(1, "Current password is required"),
	newPassword: z.string().min(8, "Password must be at least 8 characters"),
});
