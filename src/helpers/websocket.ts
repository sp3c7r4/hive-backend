import type { WSContext } from "hono/ws";
import { StatusCodes } from "http-status-codes";
import type { ZodSchema } from "zod";
import { ZodError } from "zod";
import { sendWsErrorResponse } from "./response";

export function parseWebsocketData<T>(ws: WSContext, raw: string) {
	try {
		return JSON.parse(raw) as T;
	} catch {
		return sendWsErrorResponse(
			ws,
			"Invalid JSON format",
			StatusCodes.BAD_REQUEST,
		);
	}
}

export function validateWebSocketParams<T>(
	ws: WSContext,
	schema: ZodSchema<T>,
	data: unknown,
) {
	try {
		return schema.parse(data);
	} catch (e: unknown) {
		if (e instanceof ZodError) {
			return sendWsErrorResponse(
				ws,
				`Invalid parameters: ${e.issues.map((err) => err.message).join(", ")}`,
				StatusCodes.BAD_REQUEST,
			);
		}
		throw e;
	}
}
