import { HTTPException } from "hono/http-exception";
import { StatusCodes } from "http-status-codes";

export class NotFoundError extends HTTPException {
	constructor(message: string) {
		super(StatusCodes.NOT_FOUND, { message });
	}
}
