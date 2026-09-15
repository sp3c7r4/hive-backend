import { Hono } from "hono";
import { z } from "zod";
import { requireAdmin, requireInstructor } from "@/middlewares/auth/guards";
import { JwtService, ZodEngine } from "@/services";
import { WithdrawalController } from "./withdrawal.controller";

/** @info - Mounted at /instructor/withdrawals and /admin/withdrawals */
export const instructorWithdrawalRouter = new Hono({ strict: true });
export const adminWithdrawalRouter = new Hono({ strict: true });

const jwt = JwtService.getInstance();
const zod = ZodEngine.getInstance();
const controller = WithdrawalController.getInstance();

/* @info - Bank details are NOT part of this request: the withdrawal snapshots
 *         the verified payout account server-side, so a caller cannot choose a
 *         payout destination or an account name. */
const createWithdrawalSchema = z.object({
	amount: z.number().int().positive(),
});

const payoutAccountSchema = z.object({
	bankCode: z.string().regex(/^\d{3,6}$/, "Invalid bank code"),
	accountNumber: z
		.string()
		.regex(/^\d{10}$/, "Account number must be 10 digits"),
});

const adminWithdrawalSchema = z.object({
	action: z.enum(["approve", "reject"]),
});

const verifyBankSchema = z
	.object({
		bankName: z.string().min(1).max(255).optional(),
		/* @info - The picker's identity: Paystack bank code from /bank. Kept
		 *         optional so legacy callers can still send a bank name. */
		bankCode: z.string().regex(/^\d{3,6}$/, "Invalid bank code").optional(),
		accountNumber: z
			.string()
			.regex(/^\d{10}$/, "Account number must be 10 digits"),
	})
	.refine((v) => Boolean(v.bankCode ?? v.bankName), {
		message: "A bank is required",
		path: ["bankCode"],
	});

instructorWithdrawalRouter.use("*", jwt.validateToken, requireInstructor);
instructorWithdrawalRouter.get("/", controller.listMine);
instructorWithdrawalRouter.get("/banks", controller.listBanks);
instructorWithdrawalRouter.get("/payout-account", controller.getPayoutAccount);
instructorWithdrawalRouter.put(
	"/payout-account",
	zod.validate.body(payoutAccountSchema),
	controller.savePayoutAccount,
);
instructorWithdrawalRouter.delete(
	"/payout-account",
	controller.deletePayoutAccount,
);
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
