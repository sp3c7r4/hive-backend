import { Hono } from "hono";
import { JwtService, ZodEngine } from "@/services";
import { requireInstructor } from "@/middlewares/auth";
import { FileUploadMiddleware } from "@/middlewares/upload";
import { AssignmentController } from "./submission.controller";
import { gradeSubmissionSchema, assignmentSettingsSchema, submitAssignmentSchema } from "./submission.schema";

export const submissionRouter = new Hono({ strict: true });

const jwt = JwtService.getInstance();
const zod = ZodEngine.getInstance();
const upload = FileUploadMiddleware.getInstance();
const controller = AssignmentController.getInstance();

/* Student: Submit an assignment (max 3 files) */
submissionRouter.post(
	"/",
	jwt.validateToken,
	upload.multiple({
		fieldName: "files",
		optional: true,
		sizeLimit: 10 * 1024 * 1024, // 10MB per file
		allowedTypes: [
			"application/pdf",
			"application/msword",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			"image/jpeg",
			"image/png",
			"image/gif",
			"image/webp",
		],
		maxCount: 3,
	}),
	zod.validate.formData(submitAssignmentSchema),
	controller.submit,
);

/* Student: Get my submission */
submissionRouter.get(
	"/mine/:lessonId",
	jwt.validateToken,
	controller.getMySubmission,
);

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
