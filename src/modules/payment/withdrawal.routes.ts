import { Hono } from "hono";
import { z } from "zod";
import { JwtService, ZodEngine } from "@/services";
import { requireAdmin } from "@/middlewares/auth/guards";
import { WithdrawalController } from "./withdrawal.controller";

/** @info - Mounted at /instructor/withdrawals and /admin/withdrawals */
export const instructorWithdrawalRouter = new Hono({ strict: true });
export const adminWithdrawalRouter = new Hono({ strict: true });

const jwt = JwtService.getInstance();
const zod = ZodEngine.getInstance();
const controller = WithdrawalController.getInstance();

const createWithdrawalSchema = z.object({
	amount: z.number().int().positive(),
	bankName: z.string().min(1).max(255),
	accountNumber: z.string().regex(/^\d{10}$/, "Account number must be 10 digits"),
	accountName: z.string().min(1).max(255),
});

const adminWithdrawalSchema = z.object({
	action: z.enum(["approve", "reject"]),
});

const verifyBankSchema = z.object({
	bankName: z.string().min(1).max(255),
	accountNumber: z.string().regex(/^\d{10}$/, "Account number must be 10 digits"),
});

instructorWithdrawalRouter.use("*", jwt.validateToken);
instructorWithdrawalRouter.get("/", controller.listMine);
instructorWithdrawalRouter.post(
	"/verify-account",
	zod.validate.body(verifyBankSchema),
	controller.verifyAccount,
);
instructorWithdrawalRouter.post(
	"/",
	zod.validate.body(createWithdrawalSchema),
	controller.create,
);

adminWithdrawalRouter.use("*", jwt.validateToken, requireAdmin);
adminWithdrawalRouter.get("/", controller.listAdmin);
adminWithdrawalRouter.patch(
	"/:id",
	zod.validate.body(adminWithdrawalSchema),
	controller.approveOrReject,
);
