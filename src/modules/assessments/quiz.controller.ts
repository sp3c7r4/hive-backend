import type { Context } from "hono";
import { sendSuccessResponse } from "@/helpers";
import { QuizService } from "./quiz.service";

export class QuizController {
	private static instance: QuizController | null;

	/** @info - Services */
	private readonly service: QuizService;

	static getInstance(): QuizController {
		if (!this.instance) this.instance = new QuizController();
		return this.instance;
	}

	private constructor() {
		this.service = QuizService.getInstance();
	}

	submit = async (c: Context) => {
		const authData = c.get("authData");
		const { lessonId, answers } = await c.req.json();

		const result = await this.service.submit(
			Number(authData.id),
			lessonId,
			answers,
		);

		return sendSuccessResponse(c, result);
	};

	getAttempts = async (c: Context) => {
		const authData = c.get("authData");
		const { lessonId } = c.req.param();

		const attempts = await this.service.getAttempts(
			Number(authData.id),
			Number(lessonId),
		);

		return sendSuccessResponse(c, attempts);
	};
}
