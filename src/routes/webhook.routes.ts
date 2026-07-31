import { Hono } from "hono";
import { paystackRouter } from "@/modules/payment";

export const webhookRouter = new Hono({ strict: true });

webhookRouter.route("/paystack", paystackRouter);
