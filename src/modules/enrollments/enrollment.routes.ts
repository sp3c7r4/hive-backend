import { Hono } from "hono";
import { JwtService, ZodEngine } from "@/services";
import { EnrollmentController } from "./enrollment.controller";
import { createEnrollmentSchema } from "./enrollment.schema";

export const enrollmentRouter = new Hono({ strict: true });

const jwt = JwtService.getInstance();
const zod = ZodEngine.getInstance();
const controller = EnrollmentController.getInstance();

enrollmentRouter.use("*", jwt.validateToken);

enrollmentRouter.post("/", zod.validate.body(createEnrollmentSchema), controller.enroll);
enrollmentRouter.get("/", controller.list);
enrollmentRouter.get("/:id", controller.get);

/** @info - Lesson progress within an enrollment */
enrollmentRouter.patch("/:enrollmentId/progress/:lessonId", controller.markLessonComplete);
enrollmentRouter.get("/:enrollmentId/progress", controller.getLessonProgress);
