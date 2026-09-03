import { Hono } from "hono";
import { JwtService, ZodEngine } from "@/services";
import { requireInstructor } from "@/middlewares/auth";
import { CourseBuilderController } from "./course-builder.controller";
import { draftSyllabusSchema, moduleRegenerateSchema } from "./course-builder.schema";

export const courseBuilderRouter = new Hono({ strict: true });

const jwt = JwtService.getInstance();
const zod = ZodEngine.getInstance();
const controller = CourseBuilderController.getInstance();

/* @info - Mounted at /ai/course-builder + /ai/course-builder/module
 * (router.ts registers this under /ai). Instructor-only, JWT-protected.
 * Never under /courses/:courseId: a literal "ai" segment would collide
 * with the :courseId param, and a draft has no course id yet. */
courseBuilderRouter.post(
	"/course-builder",
	jwt.validateToken,
	requireInstructor,
	zod.validate.body(draftSyllabusSchema),
	controller.draft,
);

courseBuilderRouter.post(
	"/course-builder/module",
	jwt.validateToken,
	requireInstructor,
	zod.validate.body(moduleRegenerateSchema),
	controller.moduleRegenerate,
);
