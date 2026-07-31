import type {
	HandleWebhookOptions,
	InitializeTransactionOptions,
	InitializeTransactionResult,
	VerifyTransactionOptions,
	VerifyTransactionResult,
} from "@/interfaces";
import { serviceLogger } from "@/utils";

export abstract class PaymentGatewayService {
	private name: string;
	protected log;

	constructor(paymentServiceName: string) {
		this.name = paymentServiceName || "Payment Gateway Service";
		this.log = serviceLogger(this.name);
	}

	abstract initializeTransaction: (
		options: InitializeTransactionOptions,
	) => Promise<InitializeTransactionResult | unknown>;

	abstract verifyTransaction: (
		options: VerifyTransactionOptions,
	) => Promise<VerifyTransactionResult | unknown>;

	abstract handleWebhook: (options: HandleWebhookOptions) => Promise<boolean>;
}
