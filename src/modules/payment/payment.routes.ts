import { Hono } from "hono";
import { ZodEngine } from "@/services";
import { PaymentController } from "./payment.controller";

const _zodEngine = ZodEngine.getInstance();

export const paymentRouter = new Hono({ strict: true });
/** @todo - Paystack Routes */
export const paystackRouter = new Hono({ strict: true });
export const paymentController = PaymentController.getInstance();

paystackRouter.post("/", paymentController.paystack.handleWebook);

paymentRouter.get("/cancel", paymentController.cancelPayment);
paymentRouter.get("/callback", paymentController.callbackThanks);
