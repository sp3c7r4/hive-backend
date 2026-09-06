import type { Context } from "hono";
import { sendSuccessResponse } from "@/helpers";
import { LiveService } from "./live.service";

export class LiveController {
	private static instance: LiveController;
	private readonly service = LiveService.getInstance();

	static getInstance(): LiveController {
		if (!this.instance) this.instance = new LiveController();
		return this.instance;
	}

	/** @info - POST /lessons/:lessonId/live-token */
	liveToken = async (c: Context) => {
		const authData = c.get("authData");
		const lessonId = Number(c.req.param("lessonId"));
		const result = await this.service.issueToken(authData, lessonId);
		return sendSuccessResponse(c, result);
	};

	/** @info - POST /lessons/:lessonId/go-live */
	goLive = async (c: Context) => {
		const authData = c.get("authData");
		const lessonId = Number(c.req.param("lessonId"));
		const result = await this.service.goLive(authData, lessonId);
		return sendSuccessResponse(c, result);
	};

	/** @info - POST /lessons/:lessonId/end-live */
	endLive = async (c: Context) => {
		const authData = c.get("authData");
		const lessonId = Number(c.req.param("lessonId"));
		const result = await this.service.endLive(authData, lessonId);
		return sendSuccessResponse(c, result);
	};
}
