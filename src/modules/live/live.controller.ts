import type { Context } from "hono";
import { sendSuccessResponse } from "@/helpers";
import { throwBadRequestError } from "@/helpers/errors/throw-errors";
import { LiveService } from "./live.service";
import type { CommunitySessionScope } from "./live-session.service";

/** @info - Session ids arrive as path params, so guard the Number() coercion. */
const parseSessionId = (c: Context): number => {
	const sessionId = Number(c.req.param("sessionId"));
	if (!Number.isInteger(sessionId) || sessionId <= 0) {
		throwBadRequestError("Invalid session id.");
	}
	return sessionId;
};

/** @info - Same for a community id (standalone events). */
const parseCommunityId = (c: Context): number => {
	const communityId = Number(c.req.param("communityId"));
	if (!Number.isInteger(communityId) || communityId <= 0) {
		throwBadRequestError("Invalid community id.");
	}
	return communityId;
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

	/** @info - GET /live/communities/:communityId/sessions?scope=upcoming|past */
	listCommunitySessions = async (c: Context) => {
		const authData = c.get("authData");
		const scope = (c.req.query("scope") ?? "upcoming") as CommunitySessionScope;
		const result = await this.service.listCommunitySessions(
			authData,
			parseCommunityId(c),
			scope,
		);
		return sendSuccessResponse(c, result);
	};

	/** @info - POST /live/communities/:communityId/sessions */
	createSession = async (c: Context) => {
		const authData = c.get("authData");
		const body = await c.req.json();
		const result = await this.service.createSession(
			authData,
			parseCommunityId(c),
			body,
		);
		return sendSuccessResponse(c, result);
	};

	/** @info - PATCH /live/sessions/:sessionId */
	updateSession = async (c: Context) => {
		const authData = c.get("authData");
		const body = await c.req.json();
		const result = await this.service.updateSession(
			authData,
			parseSessionId(c),
			body,
		);
		return sendSuccessResponse(c, result);
	};

	/** @info - POST /live/sessions/:sessionId/cancel */
	cancelSession = async (c: Context) => {
		const authData = c.get("authData");
		const result = await this.service.cancelSession(
			authData,
			parseSessionId(c),
		);
		return sendSuccessResponse(c, result);
	};

	/** @info - DELETE /live/sessions/:sessionId */
	deleteSession = async (c: Context) => {
		const authData = c.get("authData");
		const result = await this.service.deleteSession(
			authData,
			parseSessionId(c),
		);
		return sendSuccessResponse(c, result);
	};
}
