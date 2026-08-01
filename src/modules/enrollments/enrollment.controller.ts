import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendSuccessResponse } from "@/helpers";
import { EnrollmentService } from "./enrollment.service";

export class EnrollmentController {
	private static instance: EnrollmentController | null;

	/** @info - Services */
	private readonly service: EnrollmentService;

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

		const enrollment = await this.service.enroll({
			userId: Number(authData.id),
			courseId,
		} as any);

		return sendSuccessResponse(c, enrollment, StatusCodes.CREATED);
	};

	list = async (c: Context) => {
		const authData = c.get("authData");
		const enrollments = await this.service.listUserEnrollments(
			Number(authData.id),
		);
		return sendSuccessResponse(c, enrollments);
	};

	get = async (c: Context) => {
		const { id } = c.req.param();
		const enrollment = await this.service.getEnrollment(Number(id));
		return sendSuccessResponse(c, enrollment);
	};

	/** @info - Lesson progress */
	markLessonComplete = async (c: Context) => {
		const { enrollmentId, lessonId } = c.req.param();
		const progress = await this.service.markLessonComplete(
			Number(enrollmentId),
			Number(lessonId),
		);
		return sendSuccessResponse(c, progress);
	};

	getLessonProgress = async (c: Context) => {
		const { enrollmentId } = c.req.param();
		const progress = await this.service.getLessonProgress(
			Number(enrollmentId),
		);
		return sendSuccessResponse(c, progress);
	};
}
