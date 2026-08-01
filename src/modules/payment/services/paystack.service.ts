import crypto from "node:crypto";
import { config } from "@/config";
import {
	PaymentServiceProvider,
} from "@/enums";
import { PaystackEvents, type PaystackPaths } from "@/enums/billing/paystack";
import { throwBadRequestError } from "@/helpers/errors/throw-errors";
import type {
	HandleWebhookOptions,
	InitializeTransactionOptions,
	InitializeTransactionResult,
	VerifyTransactionOptions,
	VerifyTransactionResult,
} from "@/interfaces";
import { ApiService } from "@/services/api.service";
import { PaymentGatewayService } from "./payment-gateway.service";

const PaystackBaseUrl = "https://api.paystack.co";

export class PaystackService extends PaymentGatewayService {
	private static instance: PaystackService;

	static getInstance(): PaystackService {
		if (!this.instance) this.instance = new PaystackService();
		return this.instance;
	}

	private readonly paymentProvider: PaymentServiceProvider;

	/** @info - Services */
	private api: ApiService<PaystackPaths>;

	constructor() {
		super("Paystack Service");
		this.api = new ApiService(PaystackBaseUrl, {
			headers: {
				Authorization: `Bearer ${config.paystack.secret}`,
			},
		});
		this.paymentProvider = PaymentServiceProvider.PAYSTACK;
	}

	override initializeTransaction = async (
		options: InitializeTransactionOptions,
	): Promise<InitializeTransactionResult | unknown> => {
		try {
			const response = await this.api.post<InitializeTransactionResult>(
				"/transaction/initialize",
				options,
			);
			return response.data;
		} catch (error) {
			this.log.error("Error initializing transaction", { options, error });
			throwBadRequestError("Error initializing transaction");
		}
	};

	override verifyTransaction = async (
		options: VerifyTransactionOptions,
	): Promise<VerifyTransactionResult | unknown> => {
		try {
			const response = await this.api.get<VerifyTransactionResult>(
				`/transaction/verify/${options.reference}`,
			);
			return response.data;
		} catch (error) {
			this.log.error("Error verifying transaction", { options, error });
			throwBadRequestError("Error verifying transaction");
		}
	};

	override handleWebhook = async (
		options: HandleWebhookOptions,
	): Promise<boolean> => {
		const { paystack_signature, body } = options;
		const hash = crypto
			.createHmac("sha512", config.paystack.secret)
			.update(JSON.stringify(body))
			.digest("hex");

		if (hash === paystack_signature) {
			this.log.info(
				`Webhook received successfully from ${body.data?.ip_address}`,
			);

			const event = body.event;

			switch (event) {
				case PaystackEvents.CHARGE_SUCCESS: {
					// TODO: Route based on body.data.metadata.action
					// e.g. upgrade_plan, place_order, etc.
					this.log.info("Charge success webhook — implement your routing logic here", {
						metadata: body.data?.metadata,
					});
					return true;
				}
				default:
					return false;
			}
		}

		this.log.info("Finished executing handle webhook");
		return true;
	};
}
