import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendSuccessResponse } from "@/helpers";
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
		const data = await this.service.createCourse(await c.req.json());
		return sendSuccessResponse(c, {
			message: "Course created successfully",
			data,
		}, StatusCodes.CREATED);
	};

	list = async (c: Context) => {
		const page = Number(c.req.query("page") ?? "1");
		const limit = Number(c.req.query("limit") ?? "20");
		const data = await this.service.listCourses({ page, limit });
		return sendSuccessResponse(c, {
			message: "Courses fetched successfully",
			data,
		});
	};

	get = async (c: Context) => {
		const id = c.req.param("id");
		const data = await this.service.getCourse(id as unknown as number);
		return sendSuccessResponse(c, {
			message: "Course fetched successfully",
			data,
		});
	};

	update = async (c: Context) => {
		const id = c.req.param("id");
		const data = await this.service.updateCourse(
			id as unknown as number,
			await c.req.json(),
		);
		return sendSuccessResponse(c, {
			message: "Course updated successfully",
			data,
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
		const id = c.req.param("id");
		const data = await this.service.updateLesson(
			id as unknown as number,
			await c.req.json(),
		);
		return sendSuccessResponse(c, {
			message: "Lesson updated successfully",
			data,
		});
	};

	deleteLesson = async (c: Context) => {
		const id = c.req.param("id");
		await this.service.deleteLesson(id as unknown as number);
		return sendSuccessResponse(c, {
			message: "Lesson deleted successfully",
		});
	};
}
