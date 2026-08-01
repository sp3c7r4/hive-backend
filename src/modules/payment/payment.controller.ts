import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import {
	paymentCancelledPage,
	paymentSuccessPage,
	sendSuccessResponse,
} from "@/helpers";
import { PaymentMessage } from "@/messages";
import { PaymentService } from "./payment.service";
import { PaystackService } from "./services";

export class PaymentController {
	private static instance: PaymentController;

	/** @info - Services */
	private paymentService: PaymentService;
	private paystackService: PaystackService;

	static getInstance(): PaymentController {
		if (!this.instance) this.instance = new PaymentController();
		return this.instance;
	}

	private constructor() {
		this.paystackService = PaystackService.getInstance();
		this.paymentService = PaymentService.getInstance();
	}

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

	/** @info - Paystack methods */
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
