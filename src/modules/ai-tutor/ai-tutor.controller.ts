import type { Context } from "hono";
import { sendSuccessResponse } from "@/helpers";
import { AiTutorService } from "./ai-tutor.service";

export class AiTutorController {
	private static instance: AiTutorController;
	private readonly service = AiTutorService.getInstance();

	static getInstance(): AiTutorController {
		if (!this.instance) this.instance = new AiTutorController();
		return this.instance;
	}

	/** @info - POST /courses/:courseId/tutor/chat
	 * Streaming text when grounded; JSON envelope when the honest fallback
	 * fires. The client distinguishes by content-type. */
	chat = async (c: Context) => {
		const authData = c.get("authData");
		const courseId = Number(c.req.param("courseId"));
		const { question, lessonId } = await c.req.json();

		const result = await this.service.chat(
			authData.id,
			courseId,
			question,
			lessonId,
		);

		if (result.kind === "stream") return result.response;
		return sendSuccessResponse(c, {
			answer: result.answer,
			fallback: true,
		});
	};
}
