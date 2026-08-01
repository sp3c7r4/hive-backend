import type { Context } from "hono";
import { sendSuccessResponse } from "@/helpers";
import { QuizService } from "./quiz.service";

export class QuizController {
	private static instance: QuizController;
	private service: QuizService;

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
		const data = await this.service.submit(authData, lessonId, answers);
		return sendSuccessResponse(c, {
			message: "Quiz submitted successfully",
			data,
		});
	};

	getAttempts = async (c: Context) => {
		const authData = c.get("authData");
		const lessonId = c.req.param("lessonId");
		const data = await this.service.getAttempts(
			authData,
			lessonId as unknown as number,
		);
		return sendSuccessResponse(c, {
			message: "Quiz attempts fetched successfully",
			data,
		});
	};
}
