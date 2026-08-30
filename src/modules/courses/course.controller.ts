import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendSuccessResponse } from "@/helpers";
import { formDataToObject } from "@/helpers/middleware";
import { CourseService } from "./course.service";

export class CourseController {
	private static instance: CourseController;
	private service: CourseService;

	static getInstance(): CourseController {
		if (!this.instance) this.instance = new CourseController();
		return this.instance;
	}

	private constructor() {
		this.service = CourseService.getInstance();
	}

	/* Courses */

	create = async (c: Context) => {
		const authData = c.get("authData");

		/* FormData path — file handled by upload middleware */
		const formData = await c.req.formData();
		const data: Record<string, any> = formDataToObject(formData);
		data.coverImageUrl = c.get("uploadedFile")?.key;

		const result = await this.service.createCourse(authData, data as any);
		return sendSuccessResponse(c, {
			message: "Course created successfully",
			data: result,
		}, StatusCodes.CREATED);
	};

	list = async (c: Context) => {
		const page = Number(c.req.query("page") ?? "1");
		const limit = Number(c.req.query("limit") ?? "20");
		const communityId = c.req.query("communityId");
		const data = await this.service.listCourses({
			page,
			limit,
			...(communityId ? { communityId: Number(communityId) } : {}),
		});
		return sendSuccessResponse(c, {
			message: "Courses fetched successfully",
			data,
		});
	};

	mine = async (c: Context) => {
		const authData = c.get("authData");
		const data = await this.service.listMine(authData);
		return sendSuccessResponse(c, {
			message: "My courses fetched successfully",
			data,
		});
	};

	get = async (c: Context) => {
		const idOrSlug = c.req.param("idOrSlug") as string;
		const data = await this.service.getCourse(idOrSlug);
		return sendSuccessResponse(c, {
			message: "Course fetched successfully",
			data,
		});
	};

	update = async (c: Context) => {
		const authData = c.get("authData");
		const id = c.req.param("id");

		/* @info - Accept JSON (settings save without cover) AND multipart
		 * (cover upload). Parsing a JSON body as FormData silently yielded
		 * an empty object — updates no-op'd with a 200 response. */
		const contentType = c.req.header("content-type") ?? "";
		let data: Record<string, any>;
		if (contentType.includes("application/json")) {
			data = await c.req.json();
		} else {
			const formData = await c.req.formData();
			data = formDataToObject(formData);
			const uploadedFile = c.get("uploadedFile");
			if (uploadedFile?.key) {
				data.coverImageUrl = uploadedFile.key;
			}
		}

		const result = await this.service.updateCourse(
			authData,
			id as unknown as number,
			data as any,
		);
		return sendSuccessResponse(c, {
			message: "Course updated successfully",
			data: result,
		});
	};

	delete = async (c: Context) => {
		const id = c.req.param("id");
		await this.service.deleteCourse(id as unknown as number);
		return sendSuccessResponse(c, {
			message: "Course deleted successfully",
		});
	};

	/* Modules */

	createModule = async (c: Context) => {
		const courseId = c.req.param("courseId");
		const data = await this.service.createModule(
			courseId as unknown as number,
			await c.req.json(),
		);
		return sendSuccessResponse(c, {
			message: "Module created successfully",
			data,
		}, StatusCodes.CREATED);
	};

	listModules = async (c: Context) => {
		const courseId = c.req.param("courseId");
		const data = await this.service.listModules(
			courseId as unknown as number,
		);
		return sendSuccessResponse(c, {
			message: "Modules fetched successfully",
			data,
		});
	};

	updateModule = async (c: Context) => {
		const id = c.req.param("id");
		const data = await this.service.updateModule(
			id as unknown as number,
			await c.req.json(),
		);
		return sendSuccessResponse(c, {
			message: "Module updated successfully",
			data,
		});
	};

	deleteModule = async (c: Context) => {
		const id = c.req.param("id");
		await this.service.deleteModule(id as unknown as number);
		return sendSuccessResponse(c, {
			message: "Module deleted successfully",
		});
	};

	/* Lessons */

	createLesson = async (c: Context) => {
		const moduleId = c.req.param("moduleId");
		const data = await this.service.createLesson(
			moduleId as unknown as number,
			await c.req.json(),
		);
		return sendSuccessResponse(c, {
			message: "Lesson created successfully",
			data,
		}, StatusCodes.CREATED);
	};

	listLessons = async (c: Context) => {
		const moduleId = c.req.param("moduleId");
		const data = await this.service.listLessons(
			moduleId as unknown as number,
		);
		return sendSuccessResponse(c, {
			message: "Lessons fetched successfully",
			data,
		});
	};

	updateLesson = async (c: Context) => {
		const lessonId = c.req.param("lessonId");
		const data = await this.service.updateLesson(
			lessonId as unknown as number,
			await c.req.json(),
		);
		return sendSuccessResponse(c, {
			message: "Lesson updated successfully",
			data,
		});
	};

	deleteLesson = async (c: Context) => {
		const lessonId = c.req.param("lessonId");
		await this.service.deleteLesson(lessonId as unknown as number);
		return sendSuccessResponse(c, {
			message: "Lesson deleted successfully",
		});
	};

	/* Live Class Meeting Generation */

	generateMeeting = async (c: Context) => {
		const authData = c.get("authData");
		const lessonId = c.req.param("lessonId");
		const body = await c.req.json();
		const data = await this.service.generateMeeting(
			authData,
			lessonId as unknown as number,
			body,
		);
		return sendSuccessResponse(c, {
			message: "Meeting generated successfully",
			data,
		});
	};
}
