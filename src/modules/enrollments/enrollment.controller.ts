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
		const { courseId, paymentReference } = await c.req.json();
		const data = await this.service.enroll(authData, courseId, paymentReference);
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
		/* @info - Route params are strings; coerce here so the service, the
		 * progress row and the certificate job all carry real ids. These used to
		 * be casts (`as unknown as number`) around a string, which put a string
		 * enrollmentId into the certificate job payload. */
		const enrollmentId = Number(c.req.param("enrollmentId"));
		const lessonId = Number(c.req.param("lessonId"));
		const { row, eligibility } = await this.service.markLessonComplete(
			authData,
			enrollmentId,
			lessonId,
		);
		/* @info - `eligibility` rides along on the completion response so the
		 * learner's checklist updates without a second round trip. `data` keeps
		 * its existing shape for callers that only want the progress row. */
		return sendSuccessResponse(c, {
			message: "Lesson marked complete",
			data: row,
			eligibility,
		});
	};

	getLessonProgress = async (c: Context) => {
		const authData = c.get("authData");
		const enrollmentId = Number(c.req.param("enrollmentId"));
		const { data, eligibility } = await this.service.getLessonProgress(
			authData,
			enrollmentId,
		);
		return sendSuccessResponse(c, {
			message: "Lesson progress fetched successfully",
			data,
			eligibility,
		});
	};
}
