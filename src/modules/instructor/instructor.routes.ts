import { Hono } from "hono";
import { JwtService, ZodEngine } from "@/services";
import { requireInstructor } from "@/middlewares/auth";
import { InstructorController } from "./instructor.controller";
import { instructorStatsQuerySchema, liveClassesQuerySchema } from "./instructor.schema";

export const instructorRouter = new Hono({ strict: true });

const jwt = JwtService.getInstance();
const zod = ZodEngine.getInstance();
const controller = InstructorController.getInstance();

instructorRouter.use("*", jwt.validateToken, requireInstructor);

instructorRouter.get(
	"/stats",
	zod.validate.query(instructorStatsQuerySchema),
	controller.stats,
);

instructorRouter.get(
	"/live-classes",
	zod.validate.query(liveClassesQuerySchema),
	controller.liveClasses,
);
