import { HTTPException } from "hono/http-exception";
import { StatusCodes } from "http-status-codes";

export class ForbiddenError extends HTTPException {
	constructor(message: string) {
		super(StatusCodes.FORBIDDEN, { message });
	}
}
