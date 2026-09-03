import { Hono } from "hono";
import { JwtService, ZodEngine } from "@/services";
import { AiTutorController } from "./ai-tutor.controller";
import { tutorChatSchema, tutorChatParamsSchema } from "./ai-tutor.schema";

export const aiTutorRouter = new Hono({ strict: true });

const jwt = JwtService.getInstance();
const zod = ZodEngine.getInstance();
const controller = AiTutorController.getInstance();

/* @info - Mounted at /courses/:courseId/tutor/chat (router.ts registers
 * this under /courses alongside the course router) */
aiTutorRouter.post(
	"/:courseId/tutor/chat",
	jwt.validateToken,
	zod.validate.params(tutorChatParamsSchema),
	zod.validate.body(tutorChatSchema),
	controller.chat,
);
