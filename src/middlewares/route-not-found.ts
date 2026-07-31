import type { Context, Next } from "hono";
import { throwNotFoundError } from "@/helpers";

export const routeNotFound = async (c: Context, _: Next) => {
	throwNotFoundError(`Route ${c.req.method} ${c.req.path} does not exist`);
};
