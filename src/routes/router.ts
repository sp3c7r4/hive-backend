import { Hono } from "hono";
import { healthCheck } from "@/helpers";
import { authRouter } from "@/modules/auth";
import { paymentRouter } from "@/modules/payment";
import { testRouter } from "@/modules/test";
import { webhookRouter } from "./webhook.routes";

export const router = new Hono();

router.get("/", healthCheck);

router.route("/auth", authRouter);
router.route("/test", testRouter);
router.route("/payment", paymentRouter);
router.route("/webhook", webhookRouter);
