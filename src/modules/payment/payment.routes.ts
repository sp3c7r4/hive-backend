import { Hono } from "hono";
import { JwtService, ZodEngine } from "@/services";
import { PaymentController } from "./payment.controller";
import { z } from "zod";

export const paymentRouter = new Hono({ strict: true });
export const paystackRouter = new Hono({ strict: true });

const zod = ZodEngine.getInstance();
const jwt = JwtService.getInstance();
const controller = PaymentController.getInstance();

import { user_roles } from "@/modules/user/user-role.model";

const initializeSchema = z.object({
	type: z.enum(["enrollment", "community"]),
	courseId: z.number().optional(),
	communityId: z.number().optional(),
	amount: z.number().positive(),
});

paymentRouter.post(
	"/initialize",
	jwt.validateToken,
	zod.validate.body(initializeSchema),
	controller.initialize,
);

paymentRouter.get("/", jwt.validateToken, controller.listPayments);
paymentRouter.get("/verify/:reference", jwt.validateToken, controller.verifyPayment);

paymentRouter.get("/cancel", controller.cancelPayment);
paymentRouter.get("/callback", controller.callbackThanks);

paystackRouter.post("/", controller.paystack.handleWebook);
