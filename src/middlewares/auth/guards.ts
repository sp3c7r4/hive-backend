import type { Context, Next } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendErrorResponse } from "@/helpers/response/send-response";

/**
 * @info - Require email_verified = true. Apply to all protected routes.
 */
export const requireEmailVerified = async (c: Context, next: Next) => {
	const authData = c.get("authData");
	if (!authData?.emailVerified) {
		return sendErrorResponse(
			c,
			{ message: "Email not verified. Please verify your email to continue." },
			StatusCodes.FORBIDDEN,
		);
	}
	await next();
};

/**
 * @info - Require userType = instructor. Apply to instructor-only routes.
 */
export const requireInstructor = async (c: Context, next: Next) => {
	const authData = c.get("authData");
	if (authData?.userType !== "instructor") {
		return sendErrorResponse(
			c,
			{ message: "Instructor access required." },
			StatusCodes.FORBIDDEN,
		);
	}
	await next();
};

/**
 * @info - Require is_admin = true on an instructor. Apply to admin-only routes.
 */
export const requireAdmin = async (c: Context, next: Next) => {
	const authData = c.get("authData");
	if (authData?.userType !== "instructor" || !authData?.isAdmin) {
		return sendErrorResponse(
			c,
			{ message: "Admin access required." },
			StatusCodes.FORBIDDEN,
		);
	}
	await next();
};
