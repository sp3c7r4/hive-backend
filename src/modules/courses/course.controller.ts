import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendSuccessResponse } from "@/helpers";
import { CourseService } from "./course.service";

export class CourseController {
	private static instance: CourseController | null;

	/** @info - Services */
	private readonly service: CourseService;

	static getInstance(): CourseController {
		if (!this.instance) this.instance = new CourseController();
		return this.instance;
	}

	private constructor() {
		this.service = CourseService.getInstance();
	}

	/** @info - Courses */
	create = async (c: Context) => {
		const authData = c.get("authData");
		const body = await c.req.json();

		const course = await this.service.createCourse({
			...body,
			instructorId: Number(authData.id),
		});

		return sendSuccessResponse(c, course, StatusCodes.CREATED);
	};

	get = async (c: Context) => {
		const { id } = c.req.param();
		const course = await this.service.getCourse(Number(id));
		return sendSuccessResponse(c, course);
	};

	list = async (c: Context) => {
		const page = Number(c.req.query("page") ?? "1");
		const limit = Number(c.req.query("limit") ?? "20");
		const result = await this.service.listCourses({ page, limit });
		return sendSuccessResponse(c, result);
	};

	update = async (c: Context) => {
		const { id } = c.req.param();
		const body = await c.req.json();
		const course = await this.service.updateCourse(Number(id), body);
		return sendSuccessResponse(c, course);
	};

	delete = async (c: Context) => {
		const { id } = c.req.param();
		await this.service.deleteCourse(Number(id));
		return sendSuccessResponse(c, { message: "Course deleted" });
	};

	/** @info - Modules */
	createModule = async (c: Context) => {
		const { courseId } = c.req.param();
		const body = await c.req.json();

		const mod = await this.service.createModule({
			...body,
			courseId: Number(courseId),
		});

		return sendSuccessResponse(c, mod, StatusCodes.CREATED);
	};

	listModules = async (c: Context) => {
		const { courseId } = c.req.param();
		const modules = await this.service.listModules(Number(courseId));
		return sendSuccessResponse(c, modules);
	};

	updateModule = async (c: Context) => {
		const { id } = c.req.param();
		const body = await c.req.json();
		const mod = await this.service.updateModule(Number(id), body);
		return sendSuccessResponse(c, mod);
	};

	deleteModule = async (c: Context) => {
		const { id } = c.req.param();
		await this.service.deleteModule(Number(id));
		return sendSuccessResponse(c, { message: "Module deleted" });
	};

	/** @info - Lessons */
	createLesson = async (c: Context) => {
		const { moduleId } = c.req.param();
		const body = await c.req.json();

		const lesson = await this.service.createLesson({
			...body,
			moduleId: Number(moduleId),
		});

		return sendSuccessResponse(c, lesson, StatusCodes.CREATED);
	};

	listLessons = async (c: Context) => {
		const { moduleId } = c.req.param();
		const lessons = await this.service.listLessons(Number(moduleId));
		return sendSuccessResponse(c, lessons);
	};

	updateLesson = async (c: Context) => {
		const { id } = c.req.param();
		const body = await c.req.json();
		const lesson = await this.service.updateLesson(Number(id), body);
		return sendSuccessResponse(c, lesson);
	};

	deleteLesson = async (c: Context) => {
		const { id } = c.req.param();
		await this.service.deleteLesson(Number(id));
		return sendSuccessResponse(c, { message: "Lesson deleted" });
	};
}
