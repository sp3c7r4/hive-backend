import type { Context } from "hono";
import { AiTutorService } from "./ai-tutor.service";

export class AiTutorController {
	private static instance: AiTutorController;
	private readonly service = AiTutorService.getInstance();

	static getInstance(): AiTutorController {
		if (!this.instance) this.instance = new AiTutorController();
		return this.instance;
	}

	/** @info - POST /courses/:courseId/tutor/chat
	 * Always streams. A question the course does not cover is answered from
	 * general knowledge, so there is no non-streaming envelope any more. */
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

		return result.response;
	};
}
