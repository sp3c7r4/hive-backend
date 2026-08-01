import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { v4 as uuidv4 } from "uuid";
import {
	paymentCancelledPage,
	paymentSuccessPage,
	sendSuccessResponse,
} from "@/helpers";
import { PaymentMessage } from "@/messages";
import { PaymentService } from "./payment.service";
import { PaystackService } from "./services";
import { PaymentRepository } from "./payment.repository";

export class PaymentController {
	private static instance: PaymentController;

	private paymentService: PaymentService;
	private paystackService: PaystackService;
	private paymentRepo: PaymentRepository;

	static getInstance(): PaymentController {
		if (!this.instance) this.instance = new PaymentController();
		return this.instance;
	}

	private constructor() {
		this.paystackService = PaystackService.getInstance();
		this.paymentService = PaymentService.getInstance();
		this.paymentRepo = PaymentRepository.getInstance();
	}

	initialize = async (c: Context) => {
		const authData = c.get("authData");
		const { type, enrollmentId, communityId, studentId, amount } = await c.req.json();

		const reference = `hive-${uuidv4()}`;
		const email = authData.email;

		/** @info - Create pending payment row */
		await this.paymentRepo.create({
			payerId: Number(authData.id),
			payerType: authData.role,
			enrollmentId: enrollmentId ?? null,
			communityId: communityId ?? null,
			studentId: studentId ?? null,
			amount,
			platformFee: Math.round(amount * 0.1),
			type,
			reference,
			status: "pending",
		} as any);

		/** @info - Initialize Paystack transaction */
		const result = await this.paystackService.initializeTransaction({
			email,
			amount,
			reference,
			metadata: {
				paymentType: type,
				enrollmentId,
				communityId,
				studentId,
				payerId: authData.id,
			},
		} as any);

		return sendSuccessResponse(c, {
			authorizationUrl: (result as any).data?.authorization_url,
			reference,
		});
	};

	cancelPayment = async (c: Context) => {
		const resHtml = paymentCancelledPage();
		return c.html(resHtml, StatusCodes.OK);
	};

	callbackThanks = async (c: Context) => {
		const formatter = new Intl.NumberFormat("en-US");
		const amountQuery = c.req.query("amount") ?? "0";
		const amount = parseFloat(amountQuery);
		const resHtml = paymentSuccessPage(formatter.format(amount));
		return c.html(resHtml, StatusCodes.OK);
	};

	private handleWebhook = async (c: Context) => {
		const paystack_signature = c.req.header("x-paystack-signature");
		const body = await c.req.json();

		await this.paystackService.handleWebhook({
			paystack_signature: paystack_signature as unknown as string,
			body,
		});

		return sendSuccessResponse(c, {
			message: PaymentMessage.WEBHOOK_SUCCESS,
		});
	};

	paystack = {
		handleWebook: this.handleWebhook,
	};
}
