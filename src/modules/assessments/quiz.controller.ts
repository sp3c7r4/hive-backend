import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
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

	/* Student */

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

	/* Student: fetch quiz questions (answers stripped) */

	getLessonQuestions = async (c: Context) => {
		const lessonId = c.req.param("lessonId");
		const data = await this.service.getLessonQuestions(
			lessonId as unknown as number,
		);
		return sendSuccessResponse(c, {
			message: "Quiz questions fetched successfully",
			data,
		});
	};

	/* Instructor: quiz results per course */

	listByCourse = async (c: Context) => {
		const courseId = c.req.param("courseId");
		const data = await this.service.listByCourse(courseId as unknown as number);
		return sendSuccessResponse(c, {
			message: "Quiz results fetched successfully",
			data,
		});
	};

	/* Instructor: Quiz Builder */

	listQuestions = async (c: Context) => {
		const lessonId = c.req.param("lessonId");
		const data = await this.service.listQuestions(
			lessonId as unknown as number,
		);
		return sendSuccessResponse(c, {
			message: "Quiz questions fetched successfully",
			data,
		});
	};

	createQuestion = async (c: Context) => {
		const lessonId = c.req.param("lessonId");
		const data = await this.service.createQuestion({
			...((await c.req.json()) as any),
			lessonId: lessonId as unknown as number,
		});
		return sendSuccessResponse(c, {
			message: "Quiz question created successfully",
			data,
		}, StatusCodes.CREATED);
	};

	getQuestion = async (c: Context) => {
		const questionId = c.req.param("questionId");
		const data = await this.service.getQuestion(
			questionId as unknown as number,
		);
		return sendSuccessResponse(c, {
			message: "Quiz question fetched successfully",
			data,
		});
	};

	updateQuestion = async (c: Context) => {
		const questionId = c.req.param("questionId");
		const data = await this.service.updateQuestion(
			questionId as unknown as number,
			await c.req.json(),
		);
		return sendSuccessResponse(c, {
			message: "Quiz question updated successfully",
			data,
		});
	};

	deleteQuestion = async (c: Context) => {
		const questionId = c.req.param("questionId");
		await this.service.deleteQuestion(questionId as unknown as number);
		return sendSuccessResponse(c, {
			message: "Quiz question deleted successfully",
		});
	};
}
