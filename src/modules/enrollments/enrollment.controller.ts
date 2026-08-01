import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendSuccessResponse } from "@/helpers";
import { EnrollmentService } from "./enrollment.service";

export class EnrollmentController {
	private static instance: EnrollmentController;
	private service: EnrollmentService;

	static getInstance(): EnrollmentController {
		if (!this.instance) this.instance = new EnrollmentController();
		return this.instance;
	}

	private constructor() {
		this.service = EnrollmentService.getInstance();
	}

	enroll = async (c: Context) => {
		const authData = c.get("authData");
		const { courseId } = await c.req.json();
		const data = await this.service.enroll(authData, courseId);
		return sendSuccessResponse(c, {
			message: "Enrollment created successfully",
			data,
		}, StatusCodes.CREATED);
	};

	list = async (c: Context) => {
		const authData = c.get("authData");
		const data = await this.service.list(authData);
		return sendSuccessResponse(c, {
			message: "Enrollments fetched successfully",
			data,
		});
	};

	get = async (c: Context) => {
		const id = c.req.param("id");
		const data = await this.service.get(id as unknown as number);
		return sendSuccessResponse(c, {
			message: "Enrollment fetched successfully",
			data,
		});
	};

	markLessonComplete = async (c: Context) => {
		const authData = c.get("authData");
		const enrollmentId = c.req.param("enrollmentId");
		const lessonId = c.req.param("lessonId");
		const data = await this.service.markLessonComplete(
			authData,
			enrollmentId as unknown as number,
			lessonId as unknown as number,
		);
		return sendSuccessResponse(c, {
			message: "Lesson marked complete",
			data,
		});
	};

	getLessonProgress = async (c: Context) => {
		const enrollmentId = c.req.param("enrollmentId");
		const data = await this.service.getLessonProgress(
			enrollmentId as unknown as number,
		);
		return sendSuccessResponse(c, {
			message: "Lesson progress fetched successfully",
			data,
		});
	};
}
