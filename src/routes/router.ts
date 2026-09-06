import { Hono } from "hono";
import { healthCheck } from "@/helpers";
import { adminRouter } from "@/modules/admin";
import { aiGradingRouter } from "@/modules/ai-grading";
import { aiTutorRouter } from "@/modules/ai-tutor";
import { quizRouter, submissionRouter } from "@/modules/assessments";
import { authRouter } from "@/modules/auth";
import { certificateRouter } from "@/modules/certificates";
import { communityRouter, memberRouter } from "@/modules/communities";
import { courseBuilderRouter } from "@/modules/course-builder";
import { courseRouter, moduleRouter } from "@/modules/courses";
import { earningsRouter } from "@/modules/earnings";
import { enrollmentRouter } from "@/modules/enrollments";
import { instructorRouter } from "@/modules/instructor";
import { liveRouter } from "@/modules/live";
import { messagingRouter } from "@/modules/messaging";
import { notificationRouter } from "@/modules/notifications";
import {
	adminWithdrawalRouter,
	instructorWithdrawalRouter,
	paymentRouter,
} from "@/modules/payment";
import { reviewRouter } from "@/modules/reviews";
import { searchRouter } from "@/modules/search";
import { studentRouter } from "@/modules/student";
import { testRouter } from "@/modules/test";
import { uploadRouter } from "@/modules/upload";
import { userRouter } from "@/modules/user/user.routes";
import { webhookRouter } from "./webhook.routes";

export const router = new Hono();

router.get("/", healthCheck);

router.route("/auth", authRouter);
router.route("/ai", courseBuilderRouter);
router.route("/ai", aiGradingRouter);
router.route("/courses", aiTutorRouter);
router.route("/certificates", certificateRouter);
router.route("/reviews", reviewRouter);
router.route("/student", studentRouter);
router.route("/admin", adminRouter);
router.route("/communities", communityRouter);
router.route("/courses", courseRouter);
router.route("/enrollments", enrollmentRouter);
router.route("/instructor/earnings", earningsRouter);
router.route("/instructor", instructorRouter);
router.route("/messages", messagingRouter);
router.route("/members", memberRouter);
router.route("/modules", moduleRouter);
router.route("/quiz", quizRouter);
router.route("/submissions", submissionRouter);
router.route("/test", testRouter);
router.route("/lessons", liveRouter);
router.route("/payment", paymentRouter);
router.route("/notifications", notificationRouter);
router.route("/search", searchRouter);
router.route("/instructor/withdrawals", instructorWithdrawalRouter);
router.route("/admin/withdrawals", adminWithdrawalRouter);
router.route("/upload", uploadRouter);
router.route("/user", userRouter);
router.route("/webhook", webhookRouter);
