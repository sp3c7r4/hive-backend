import { HTTPException } from "hono/http-exception";
import { StatusCodes } from "http-status-codes";

export class RateLimitError extends HTTPException {
	constructor(message: string) {
		super(StatusCodes.TOO_MANY_REQUESTS, { message });
	}
}
