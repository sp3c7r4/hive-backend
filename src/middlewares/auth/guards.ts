import { eq, and, or } from "drizzle-orm";
import type { Context, Next } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendErrorResponse } from "@/helpers/response/send-response";
import { getDb } from "@/db/postgres.db";
import { user_roles } from "@/modules/user/user-role.model";
import { instructorProfiles } from "@/modules/instructor/instructor.model";

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
 * @info - Query user_roles table. Require the "instructor" role.
 *         Works regardless of whether the JWT carries a userType claim.
 */
export const requireInstructor = async (c: Context, next: Next) => {
	const authData = c.get("authData");
	if (!authData?.id) {
		return sendErrorResponse(
			c,
			{ message: "Instructor access required." },
			StatusCodes.FORBIDDEN,
		);
	}

	const db = getDb();
	const [row] = await db
		.select()
		.from(user_roles)
		.where(
			and(
				eq(user_roles.userId, Number(authData.id)),
				eq(user_roles.role, "instructor"),
			),
		)
		.limit(1);

	if (!row) {
		return sendErrorResponse(
			c,
			{ message: "Instructor access required. Please select the instructor role first." },
			StatusCodes.FORBIDDEN,
		);
	}
	await next();
};

/**
 * @info - Platform admins hold role 'admin' (user_roles). The legacy
 * path (instructor role + instructor_profiles.is_admin = true) is still
 * honored. Before 2026-09-05 this guard ONLY accepted the legacy path,
 * so role-admin accounts (e.g. the seeded QA admin) got 403 on every
 * /admin endpoint while no account on prod had is_admin set.
 */
export const requireAdmin = async (c: Context, next: Next) => {
	const authData = c.get("authData");
	if (!authData?.id) {
		return sendErrorResponse(
			c,
			{ message: "Admin access required." },
			StatusCodes.FORBIDDEN,
		);
	}

	const db = getDb();

	/* Check the user holds role admin OR instructor (legacy) */
	const [roleRow] = await db
		.select()
		.from(user_roles)
		.where(
			and(
				eq(user_roles.userId, Number(authData.id)),
				or(
					eq(user_roles.role, "admin"),
					eq(user_roles.role, "instructor"),
				),
			),
		)
		.limit(1);

	if (!roleRow) {
		return sendErrorResponse(
			c,
			{ message: "Admin access required." },
			StatusCodes.FORBIDDEN,
		);
	}

	/* Role 'admin' alone is sufficient (the modern grant path) */
	if (roleRow.role === "admin") {
		await next();
		return;
	}

	/* Legacy: instructor role still needs the profile admin flag */
	const [profile] = await db
		.select()
		.from(instructorProfiles)
		.where(eq(instructorProfiles.userId, Number(authData.id)))
		.limit(1);

	if (!profile || !profile.isAdmin) {
		return sendErrorResponse(
			c,
			{ message: "Admin access required." },
			StatusCodes.FORBIDDEN,
		);
	}
	await next();
};
