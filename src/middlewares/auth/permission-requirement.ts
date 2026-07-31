import type { Context, MiddlewareHandler, Next } from "hono";
import type { UserTypes } from "@/enums";
import { throwForbiddenError, throwUnauthorizedError } from "@/helpers";

export const permissionRequirement = (
	userTypes: UserTypes[],
): MiddlewareHandler => {
	return async (c: Context, next: Next) => {
		const user = c.get("authData") ?? throwUnauthorizedError("Unauthorized");
		if (!userTypes.includes(user.userType as UserTypes)) {
			throwForbiddenError("You are not authorized to access this resource");
		}
		await next();
	};
};
