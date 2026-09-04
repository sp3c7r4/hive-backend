import { Hono } from "hono";
import { JwtService, ZodEngine } from "@/services";
import { requireInstructor } from "@/middlewares/auth";
import { AiGradingController } from "./ai-grading.controller";
import {
	approveSuggestionSchema,
	massGradeSchema,
	suggestGradeSchema,
} from "./ai-grading.service";

export const aiGradingRouter = new Hono({ strict: true });

const jwt = JwtService.getInstance();
const zod = ZodEngine.getInstance();
const controller = AiGradingController.getInstance();

/* @info - Mounted at /ai/grading/... (router.ts registers this under /ai
 * alongside the course builder). Instructor-only, JWT-protected. */
aiGradingRouter.use("*", jwt.validateToken, requireInstructor);

aiGradingRouter.post(
	"/grading/single",
	zod.validate.body(suggestGradeSchema),
	controller.suggest,
);

aiGradingRouter.post(
	"/grading/batches",
	zod.validate.body(massGradeSchema),
	controller.massGrade,
);

aiGradingRouter.get("/grading/batches/:batchId", controller.batchSnapshot);

aiGradingRouter.get("/grading/batches/:batchId/stream", controller.stream);

aiGradingRouter.get("/grading/review", controller.reviewList);

aiGradingRouter.patch(
	"/grading/review/:submissionId/approve",
	zod.validate.body(approveSuggestionSchema),
	controller.approve,
);

aiGradingRouter.post(
	"/grading/review/:submissionId/decline",
	controller.decline,
);

aiGradingRouter.post(
	"/grading/review/:submissionId/regenerate",
	controller.regenerate,
);
