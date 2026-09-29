import { Hono } from "hono";
import { JwtService, ZodEngine } from "@/services";
import { requireInstructor } from "@/middlewares/auth";
import { QuizController } from "./quiz.controller";
import {
	assessmentAutosaveSchema,
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

/* Instructor: quiz results per course (must be before :lessonId) */
quizRouter.get(
	"/attempts/course/:courseId",
	jwt.validateToken,
	requireInstructor,
	controller.listByCourse,
);

/* Student: view attempts */
quizRouter.get(
	"/attempts/:lessonId",
	jwt.validateToken,
	controller.getAttempts,
);

/* Student: autosave one answer. Assessment lessons only, and only while the
 * attempt is open — no score and no correctness comes back, so it cannot be used
 * as an answer oracle. */
quizRouter.post(
	"/attempts/autosave",
	jwt.validateToken,
	zod.validate.body(assessmentAutosaveSchema),
	controller.autosaveAttempt,
);

/* Student: assessment attempt — start (idempotent) and read state */
quizRouter.post(
	"/lessons/:lessonId/assessment/start",
	jwt.validateToken,
	controller.startAssessment,
);

quizRouter.get(
	"/lessons/:lessonId/assessment/session",
	jwt.validateToken,
	controller.getAssessmentSession,
);

/* Student: fetch quiz questions (answers stripped) */
quizRouter.get(
	"/lessons/:lessonId/take",
	jwt.validateToken,
	controller.getLessonQuestions,
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
