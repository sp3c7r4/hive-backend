import { z } from "zod";
import { AuthLoginTypes, UserRole } from "@/enums";

export const createUserSchema = z.object({
	firstName: z.string().min(1),
	lastName: z.string().min(1),
	email: z.string().email(),
	password: z.string().min(8),
	role: z.enum(Object.values(UserRole) as [string, ...string[]]),
});

export const loginUserSchema = z
	.object({
		email: z.string().email(),
		password: z.string().min(8).optional(),
		loginType: z.enum(Object.values(AuthLoginTypes) as [string, ...string[]]),
	})
	.superRefine((data, ctx) => {
		if (data.loginType === AuthLoginTypes.PASSWORD && !data.password) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Password is required",
			});
		}
	});

export const verifyEmailSchema = z.object({
	otp: z
		.string()
		.length(6)
		.transform((val) => Number(val.trim())),
});

export const refreshTokenSchema = z.object({
	refreshToken: z.string(),
});

export const forgotPasswordSchema = z.object({
	email: z.string().email(),
});

export const resetPasswordSchema = z.object({
	password: z.string().min(8),
});

export const OAuthAuthenticateSchema = z.object({
	role: z.enum(Object.values(UserRole) as [string, ...string[]]),
});
