import type { Context } from "hono";
import { sendSuccessResponse } from "@/helpers";
import { formDataToObject } from "@/helpers/middleware";
import { AssignmentService } from "./submission.service";

export class AssignmentController {
	private static instance: AssignmentController;
	private service: AssignmentService;

	static getInstance(): AssignmentController {
		if (!this.instance) this.instance = new AssignmentController();
		return this.instance;
	}

	private constructor() {
		this.service = AssignmentService.getInstance();
	}

	/* Student: Submit an assignment */

	submit = async (c: Context) => {
		const authData = c.get("authData");
		const { lessonId, text } = formDataToObject(await c.req.formData()) as {
			lessonId?: number;
			text?: string;
		};
		const uploadedFiles = c.get("uploadedFiles") as Array<{ key: string }> | undefined;
		const fileUrls = uploadedFiles?.map((f) => f.key) ?? [];
		const data = await this.service.submit(authData, lessonId!, text, fileUrls);
		return sendSuccessResponse(c, { message: "Assignment submitted successfully", data });
	};

	/* Student: Get my submission for a lesson */

	getMySubmission = async (c: Context) => {
		const authData = c.get("authData");
		const lessonId = c.req.param("lessonId");
		const data = await this.service.getByUserAndLesson(authData.id, lessonId as unknown as number);
		return sendSuccessResponse(c, { message: "Submission fetched", data });
	};

	/* Instructor: List submissions for a course */

	listByCourse = async (c: Context) => {
		const courseId = c.req.param("courseId");
		const page = Number(c.req.query("page") ?? "1");
		const limit = Number(c.req.query("limit") ?? "20");
		const status = c.req.query("status");

		const data = await this.service.listByCourse(
			courseId as unknown as number,
			{ page, limit, status },
		);
		return sendSuccessResponse(c, {
			message: "Submissions fetched successfully",
			data,
		});
	};

	/* Instructor/Student: Get single submission */

	get = async (c: Context) => {
		const id = c.req.param("submissionId");
		const data = await this.service.get(id as unknown as number);
		return sendSuccessResponse(c, {
			message: "Submission fetched successfully",
			data,
		});
	};

	/* Instructor: Grade a submission */

	grade = async (c: Context) => {
		const id = c.req.param("submissionId");
		const data = await this.service.grade(
			id as unknown as number,
			await c.req.json(),
		);
		return sendSuccessResponse(c, {
			message: "Submission graded successfully",
			data,
		});
	};

	/* Instructor: Update assignment settings on a lesson */

	updateAssignmentSettings = async (c: Context) => {
		const lessonId = c.req.param("lessonId");
		const data = await this.service.updateAssignmentSettings(
			lessonId as unknown as number,
			await c.req.json(),
		);
		return sendSuccessResponse(c, {
			message: "Assignment settings updated successfully",
			data,
		});
	};
}
