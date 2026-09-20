import { HTTPException } from "hono/http-exception";
import { StatusCodes } from "http-status-codes";

/** @info - 410, for the one resource this API has that was genuinely taken away: a
 *  recording the bucket's 90-day lifecycle has deleted (D-P5-5). A 404 would say "there
 *  never was one", which is the wrong story to tell someone who paid for the class. */
export class GoneError extends HTTPException {
	constructor(message: string) {
		super(StatusCodes.GONE, { message });
	}
}
