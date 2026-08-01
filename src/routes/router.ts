import { Hono } from "hono";
import { healthCheck } from "@/helpers";
import { authRouter } from "@/modules/auth";
import { communityRouter } from "@/modules/communities";
import { courseRouter, moduleRouter } from "@/modules/courses";
import { enrollmentRouter } from "@/modules/enrollments";
import { paymentRouter } from "@/modules/payment";
import { testRouter } from "@/modules/test";
import { uploadRouter } from "@/modules/upload";
import { webhookRouter } from "./webhook.routes";

export const router = new Hono();

router.get("/", healthCheck);

router.route("/auth", authRouter);
router.route("/communities", communityRouter);
router.route("/courses", courseRouter);
router.route("/enrollments", enrollmentRouter);
router.route("/modules", moduleRouter);
router.route("/test", testRouter);
router.route("/payment", paymentRouter);
router.route("/upload", uploadRouter);
router.route("/webhook", webhookRouter);
