import { HTTPException } from "hono/http-exception";
import { StatusCodes } from "http-status-codes";

export class BadRequestError extends HTTPException {
	constructor(message: string) {
		super(StatusCodes.BAD_REQUEST, { message });
	}
}
