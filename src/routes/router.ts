import { Hono } from "hono";
import { healthCheck } from "@/helpers";
import { paymentRouter } from "@/modules/payment";
import { webhookRouter } from "./webhook.routes";

export const router = new Hono();

router.get("/", healthCheck);

router.route("/payment", paymentRouter);

router.route("/webhook", webhookRouter);
