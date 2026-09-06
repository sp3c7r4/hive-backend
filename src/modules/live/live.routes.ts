import { Hono } from "hono";
import { requireInstructor } from "@/middlewares/auth";
import { JwtService } from "@/services";
import { LiveController } from "./live.controller";

export const liveRouter = new Hono({ strict: true });

const jwt = JwtService.getInstance();
const controller = LiveController.getInstance();

/** @info - All live routes require an authenticated user */
liveRouter.use("*", jwt.validateToken);

/** @info - Join token: instructor (owner) publishes; enrolled students subscribe */
liveRouter.post("/:lessonId/live-token", controller.liveToken);

/** @info - Session state transitions: instructor owns the course's lesson */
liveRouter.post("/:lessonId/go-live", requireInstructor, controller.goLive);
liveRouter.post("/:lessonId/end-live", requireInstructor, controller.endLive);
