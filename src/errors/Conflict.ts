import { HTTPException } from "hono/http-exception";
import { StatusCodes } from "http-status-codes";

export class ConflictError extends HTTPException {
	constructor(message: string) {
		super(StatusCodes.CONFLICT, { message });
	}
}

export const createConflictError = (message: string) => {
	return new ConflictError(message);
};
