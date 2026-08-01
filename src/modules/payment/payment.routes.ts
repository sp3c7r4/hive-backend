import { Hono } from "hono";
import { JwtService, ZodEngine } from "@/services";
import { PaymentController } from "./payment.controller";
import { z } from "zod";

export const paymentRouter = new Hono({ strict: true });
export const paystackRouter = new Hono({ strict: true });

const zod = ZodEngine.getInstance();
const jwt = JwtService.getInstance();
const controller = PaymentController.getInstance();

const initializeSchema = z.object({
	type: z.enum(["enrollment", "community"]),
	enrollmentId: z.number().optional(),
	communityId: z.number().optional(),
	studentId: z.number().optional(),
	amount: z.number().positive(),
});

paymentRouter.post(
	"/initialize",
	jwt.validateToken,
	zod.validate.body(initializeSchema),
	controller.initialize,
);

paymentRouter.get("/cancel", controller.cancelPayment);
paymentRouter.get("/callback", controller.callbackThanks);

paystackRouter.post("/", controller.paystack.handleWebook);
