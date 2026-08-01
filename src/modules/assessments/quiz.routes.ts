import { Hono } from "hono";
import { JwtService, ZodEngine } from "@/services";
import { requireInstructor } from "@/middlewares/auth";
import { QuizController } from "./quiz.controller";
import {
	quizSubmissionSchema,
	createQuizQuestionSchema,
	updateQuizQuestionSchema,
} from "./quiz.schema";

export const quizRouter = new Hono({ strict: true });

const jwt = JwtService.getInstance();
const zod = ZodEngine.getInstance();
const controller = QuizController.getInstance();

/* Student: submit quiz */
quizRouter.post(
	"/attempts",
	jwt.validateToken,
	zod.validate.body(quizSubmissionSchema),
	controller.submit,
);

/* Student: view attempts */
quizRouter.get(
	"/attempts/:lessonId",
	jwt.validateToken,
	controller.getAttempts,
);

/* Instructor: Quiz Builder */
quizRouter.get(
	"/lessons/:lessonId/questions",
	jwt.validateToken,
	requireInstructor,
	controller.listQuestions,
);

quizRouter.post(
	"/lessons/:lessonId/questions",
	jwt.validateToken,
	requireInstructor,
	zod.validate.body(createQuizQuestionSchema),
	controller.createQuestion,
);

quizRouter.get(
	"/questions/:questionId",
	jwt.validateToken,
	requireInstructor,
	controller.getQuestion,
);

quizRouter.patch(
	"/questions/:questionId",
	jwt.validateToken,
	requireInstructor,
	zod.validate.body(updateQuizQuestionSchema),
	controller.updateQuestion,
);

quizRouter.delete(
	"/questions/:questionId",
	jwt.validateToken,
	requireInstructor,
	controller.deleteQuestion,
);
