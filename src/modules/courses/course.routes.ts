import { Hono } from "hono";
import { JwtService, ZodEngine } from "@/services";
import { requireInstructor } from "@/middlewares/auth";
import { CourseController } from "./course.controller";
import {
	createCourseSchema,
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
const controller = CourseController.getInstance();

/** @info - All course routes require auth */
courseRouter.use("*", jwt.validateToken);

/** @info - Course CRUD */
courseRouter.post("/", zod.validate.body(createCourseSchema), controller.create);
courseRouter.get("/", controller.list);
courseRouter.get("/:id", controller.get);
courseRouter.patch("/:id", zod.validate.body(updateCourseSchema), controller.update);
courseRouter.delete("/:id", controller.delete);

/** @info - Module routes nested under courses */
courseRouter.get("/:courseId/modules", controller.listModules);
courseRouter.post("/:courseId/modules", zod.validate.body(createModuleSchema), controller.createModule);

/** @info - Live class meeting generation — instructor only */
courseRouter.post(
	"/:courseId/modules/:moduleId/lessons/:lessonId/generate-meeting",
	jwt.validateToken,
	requireInstructor,
	zod.validate.body(generateMeetingSchema),
	controller.generateMeeting,
);

export const moduleRouter = new Hono({ strict: true });
moduleRouter.use("*", jwt.validateToken);

moduleRouter.patch("/:id", zod.validate.body(updateModuleSchema), controller.updateModule);
moduleRouter.delete("/:id", controller.deleteModule);

/** @info - Lesson routes nested under modules */
moduleRouter.get("/:moduleId/lessons", controller.listLessons);
moduleRouter.post("/:moduleId/lessons", zod.validate.body(createLessonSchema), controller.createLesson);
moduleRouter.patch("/:id", zod.validate.body(updateLessonSchema), controller.updateLesson);
moduleRouter.delete("/:id", controller.deleteLesson);
