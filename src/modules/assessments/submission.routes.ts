import { Hono } from "hono";
import { JwtService, ZodEngine } from "@/services";
import { requireInstructor } from "@/middlewares/auth";
import { AssignmentController } from "./submission.controller";
import { gradeSubmissionSchema, assignmentSettingsSchema } from "./submission.schema";

export const submissionRouter = new Hono({ strict: true });

const jwt = JwtService.getInstance();
const zod = ZodEngine.getInstance();
const controller = AssignmentController.getInstance();

/* Instructor: List submissions by course */
submissionRouter.get(
	"/courses/:courseId",
	jwt.validateToken,
	requireInstructor,
	controller.listByCourse,
);

/* Instructor/Student: Get single submission */
submissionRouter.get(
	"/:submissionId",
	jwt.validateToken,
	controller.get,
);

/* Instructor: Grade a submission */
submissionRouter.patch(
	"/:submissionId/grade",
	jwt.validateToken,
	requireInstructor,
	zod.validate.body(gradeSubmissionSchema),
	controller.grade,
);

/* Instructor: Update assignment settings on a lesson */
submissionRouter.patch(
	"/lessons/:lessonId/settings",
	jwt.validateToken,
	requireInstructor,
	zod.validate.body(assignmentSettingsSchema),
	controller.updateAssignmentSettings,
);
