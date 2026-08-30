import { Hono } from "hono";
import { JwtService, ZodEngine } from "@/services";
import { requireInstructor } from "@/middlewares/auth";
import { FileUploadMiddleware } from "@/middlewares/upload";
import { FILE_SIZES } from "@/constants/file-size";
import { ImageMimeType } from "@/enums";
import { CourseController } from "./course.controller";
import {
	createCourseFormSchema,
	createModuleSchema,
	createLessonSchema,
	updateCourseSchema,
	updateModuleSchema,
	updateLessonSchema,
	generateMeetingSchema,
} from "./course.schema";

export const courseRouter = new Hono({ strict: true });

const jwt = JwtService.getInstance();
const zod = ZodEngine.getInstance();
const upload = FileUploadMiddleware.getInstance();
const controller = CourseController.getInstance();

/** @info - All course routes require auth */
courseRouter.use("*", jwt.validateToken);

/** @info - Course CRUD */
courseRouter.post(
	"/",
	requireInstructor,
	zod.validate.formData(createCourseFormSchema),
	upload.single({
		fieldName: "coverImage",
		sizeLimit: FILE_SIZES["5MB"],
		allowedTypes: [ImageMimeType.JPEG, ImageMimeType.PNG, ImageMimeType.WEBP],
		optional: true,
	}),
	controller.create,
);
courseRouter.get("/", controller.list);
courseRouter.get("/mine", controller.mine);
courseRouter.get("/:idOrSlug", controller.get);
courseRouter.patch(
	"/:id",
	requireInstructor,
	upload.single({
		fieldName: "coverImage",
		sizeLimit: FILE_SIZES["5MB"],
		allowedTypes: [ImageMimeType.JPEG, ImageMimeType.PNG, ImageMimeType.WEBP],
		optional: true,
	}),
	controller.update,
);
courseRouter.delete("/:id", requireInstructor, controller.delete);

/** @info - Module routes nested under courses */
courseRouter.get("/:courseId/modules", controller.listModules);
courseRouter.post("/:courseId/modules", requireInstructor, zod.validate.body(createModuleSchema), controller.createModule);

/** @info - Live class meeting generation — instructor only */
courseRouter.post(
	"/:courseId/modules/:moduleId/lessons/:lessonId/generate-meeting",
	requireInstructor,
	zod.validate.body(generateMeetingSchema),
	controller.generateMeeting,
);

export const moduleRouter = new Hono({ strict: true });
moduleRouter.use("*", jwt.validateToken);

moduleRouter.patch("/:id", requireInstructor, zod.validate.body(updateModuleSchema), controller.updateModule);
moduleRouter.delete("/:id", requireInstructor, controller.deleteModule);

/** @info - Lesson routes nested under modules */
moduleRouter.get("/:moduleId/lessons", controller.listLessons);
moduleRouter.post("/:moduleId/lessons", requireInstructor, zod.validate.body(createLessonSchema), controller.createLesson);
moduleRouter.patch("/:moduleId/lessons/:lessonId", requireInstructor, zod.validate.body(updateLessonSchema), controller.updateLesson);
moduleRouter.delete("/:moduleId/lessons/:lessonId", requireInstructor, controller.deleteLesson);
