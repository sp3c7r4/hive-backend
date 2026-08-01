import { Hono } from "hono";
import { JwtService, ZodEngine } from "@/services";
import { QuizController } from "./quiz.controller";
import { quizSubmissionSchema } from "./quiz.schema";

export const quizRouter = new Hono({ strict: true });

const jwt = JwtService.getInstance();
const zod = ZodEngine.getInstance();
const controller = QuizController.getInstance();

quizRouter.use("*", jwt.validateToken);

quizRouter.post("/attempts", zod.validate.body(quizSubmissionSchema), controller.submit);
quizRouter.get("/attempts/:lessonId", controller.getAttempts);
