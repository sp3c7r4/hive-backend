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

	/* @info - M3 payouts: bank recipient + transfer */
	abstract resolveBankCode: (bankName: string) => Promise<string | null>;

	abstract resolveAccountNumber: (
		accountNumber: string,
		bankCode: string,
	) => Promise<{ accountNumber: string; accountName: string } | null>;

	abstract createRecipient: (options: {
		bankCode: string;
		accountNumber: string;
		accountName: string;
	}) => Promise<{ recipientCode: string } | unknown>;

	abstract transfer: (options: {
		recipientCode: string;
		amount: number;
		reference: string;
	}) => Promise<{ status: string; transferCode: string } | unknown>;
}
