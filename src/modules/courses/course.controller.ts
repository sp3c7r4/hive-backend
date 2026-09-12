import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { sendSuccessResponse } from "@/helpers";
import { formDataToObject } from "@/helpers/middleware";
import { CourseService } from "./course.service";

/** @info - zValidator stores the parsed form under the request's validation
 * targets; the plain Context type does not expose that generic, so read it
 * through this narrow accessor instead of the raw body. */
const validatedForm = (c: Context): Record<string, unknown> => {
	const req = c.req as unknown as {
		valid: (target: "form") => Record<string, unknown> | undefined;
	};
	return req.valid("form") ?? {};
};

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

		/* @info - The validated form is the create contract. Reading it back
		 * (instead of the raw FormData) is what keeps a stray form key from
		 * reaching the insert; the upload middleware's key is the only value
		 * merged from outside the schema. */
		const validated = validatedForm(c);
		const data: Record<string, unknown> = Object.fromEntries(
			Object.entries(validated).filter(([, value]) => value !== undefined),
		);
		const coverImageUrl = c.get("uploadedFile")?.key;
		if (coverImageUrl) data.coverImageUrl = coverImageUrl;

		const result = await this.service.createCourse(authData, data as any);
		return sendSuccessResponse(
			c,
			{
				message: "Course created successfully",
				data: result,
			},
			StatusCodes.CREATED,
		);
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
		const deleted = c.req.query("deleted") === "true";
		const data = await this.service.listMine(authData, deleted);
		return sendSuccessResponse(c, {
			message: "My courses fetched successfully",
			data,
		});
	};

	get = async (c: Context) => {
		const idOrSlug = c.req.param("idOrSlug") as string;
		const authData = c.get("authData");
		const data = await this.service.getCourse(idOrSlug, authData);
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

	/** @info - Move a course to another community. Separate from `update` because
	 * the update allowlist strips communityId (mass-assignment), so the one column
	 * that decides which community the course belongs to gets its own contract. */
	moveCommunity = async (c: Context) => {
		const authData = c.get("authData");
		const id = c.req.param("id");
		const body = (await c.req.json()) as { communityId?: unknown };
		const data = await this.service.moveCourseCommunity(
			authData,
			id as unknown as number,
			Number(body?.communityId),
		);
		return sendSuccessResponse(c, {
			message: "Course moved successfully",
			data,
		});
	};

	delete = async (c: Context) => {
		const authData = c.get("authData");
		const id = c.req.param("id");
		await this.service.deleteCourse(authData, id as unknown as number);
		return sendSuccessResponse(c, {
			message: "Course deleted successfully",
		});
	};

	restore = async (c: Context) => {
		const authData = c.get("authData");
		const id = c.req.param("id");
		const data = await this.service.restoreCourse(
			authData,
			id as unknown as number,
		);
		return sendSuccessResponse(c, {
			message: "Course restored successfully",
			data,
		});
	};

	/* Modules */

	createModule = async (c: Context) => {
		const authData = c.get("authData");
		const courseId = c.req.param("courseId");
		const data = await this.service.createModule(
			authData,
			courseId as unknown as number,
			await c.req.json(),
		);
		return sendSuccessResponse(
			c,
			{
				message: "Module created successfully",
				data,
			},
			StatusCodes.CREATED,
		);
	};

	listModules = async (c: Context) => {
		const courseId = c.req.param("courseId");
		const authData = c.get("authData");
		const data = await this.service.listModules(
			courseId as unknown as number,
			authData,
		);
		return sendSuccessResponse(c, {
			message: "Modules fetched successfully",
			data,
		});
	};

	updateModule = async (c: Context) => {
		const authData = c.get("authData");
		const id = c.req.param("id");
		const data = await this.service.updateModule(
			authData,
			id as unknown as number,
			await c.req.json(),
		);
		return sendSuccessResponse(c, {
			message: "Module updated successfully",
			data,
		});
	};

	deleteModule = async (c: Context) => {
		const authData = c.get("authData");
		const id = c.req.param("id");
		await this.service.deleteModule(authData, id as unknown as number);
		return sendSuccessResponse(c, {
			message: "Module deleted successfully",
		});
	};

	/* Lessons */

	createLesson = async (c: Context) => {
		const authData = c.get("authData");
		const moduleId = c.req.param("moduleId");
		const data = await this.service.createLesson(
			authData,
			moduleId as unknown as number,
			await c.req.json(),
		);
		return sendSuccessResponse(
			c,
			{
				message: "Lesson created successfully",
				data,
			},
			StatusCodes.CREATED,
		);
	};

	listLessons = async (c: Context) => {
		const moduleId = c.req.param("moduleId");
		const authData = c.get("authData");
		const data = await this.service.listLessons(
			moduleId as unknown as number,
			authData,
		);
		return sendSuccessResponse(c, {
			message: "Lessons fetched successfully",
			data,
		});
	};

	updateLesson = async (c: Context) => {
		const authData = c.get("authData");
		const lessonId = c.req.param("lessonId");
		const data = await this.service.updateLesson(
			authData,
			lessonId as unknown as number,
			await c.req.json(),
		);
		return sendSuccessResponse(c, {
			message: "Lesson updated successfully",
			data,
		});
	};

	deleteLesson = async (c: Context) => {
		const authData = c.get("authData");
		const lessonId = c.req.param("lessonId");
		await this.service.deleteLesson(authData, lessonId as unknown as number);
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
