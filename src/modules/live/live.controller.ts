import type { Context } from "hono";
import { sendSuccessResponse } from "@/helpers";
import { throwBadRequestError } from "@/helpers/errors/throw-errors";
import { LiveService } from "./live.service";

/** @info - Session ids arrive as path params, so guard the Number() coercion. */
const parseSessionId = (c: Context): number => {
	const sessionId = Number(c.req.param("sessionId"));
	if (!Number.isInteger(sessionId) || sessionId <= 0) {
		throwBadRequestError("Invalid session id.");
	}
	return sessionId;
};

export class LiveController {
	private static instance: LiveController;
	private readonly service = LiveService.getInstance();

	static getInstance(): LiveController {
		if (!this.instance) this.instance = new LiveController();
		return this.instance;
	}

	/** @info - GET /live/sessions/:sessionId */
	getSession = async (c: Context) => {
		const authData = c.get("authData");
		const result = await this.service.getSession(authData, parseSessionId(c));
		return sendSuccessResponse(c, result);
	};

	/** @info - POST /live/sessions/:sessionId/token */
	liveToken = async (c: Context) => {
		const authData = c.get("authData");
		const result = await this.service.issueToken(authData, parseSessionId(c));
		return sendSuccessResponse(c, result);
	};

	/** @info - POST /live/sessions/:sessionId/go-live */
	goLive = async (c: Context) => {
		const authData = c.get("authData");
		const result = await this.service.goLive(authData, parseSessionId(c));
		return sendSuccessResponse(c, result);
	};

	/** @info - POST /live/sessions/:sessionId/end-live */
	endLive = async (c: Context) => {
		const authData = c.get("authData");
		const result = await this.service.endLive(authData, parseSessionId(c));
		return sendSuccessResponse(c, result);
	};
}
