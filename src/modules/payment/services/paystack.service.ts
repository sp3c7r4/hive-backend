import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { config } from "@/config";
import {
	PaymentServiceProvider,
	LedgerTransactionType,
	LedgerTransactionCategory,
} from "@/enums";
import { PaystackEvents, type PaystackPaths } from "@/enums/billing/paystack";
import { throwBadRequestError } from "@/helpers/errors/throw-errors";
import { withTransaction } from "@/helpers/db.helper";
import { getDb } from "@/db/postgres.db";
import { payments } from "../payment.model";
import { instructorBalance, instructorTransaction } from "../ledger.model";
import { courses } from "@/modules/courses/course.model";
import { communities } from "@/modules/communities/community.model";
import type {
	HandleWebhookOptions,
	InitializeTransactionOptions,
	InitializeTransactionResult,
	TransferOptions,
	TransferRecipientOptions,
	VerifyTransactionOptions,
	VerifyTransactionResult,
} from "@/interfaces";
import { ApiService } from "@/services/api.service";
import { PaymentGatewayService } from "./payment-gateway.service";
import { PaymentSettlementService } from "./payment-settlement.service";

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
	private settlement = PaymentSettlementService.getInstance();

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
		/* @info - Verify over the RAW body bytes (Paystack signs the received payload) */
		const raw = options.rawBody ?? JSON.stringify(body);
		const hash = crypto
			.createHmac("sha512", config.paystack.secret)
			.update(raw)
			.digest("hex");

		if (hash === paystack_signature) {
			this.log.info(
				`Webhook received successfully from ${body.data?.ip_address}`,
			);

			const event = body.event;

			switch (event) {
				case PaystackEvents.CHARGE_SUCCESS: {
					/* @info - Credit the instructor ledger for a successful charge */
					return await this.handleChargeSuccess(
						body.data?.reference as string,
						body.data?.metadata,
						body.data,
					);
				}
				default:
					return false;
			}
		}

		this.log.info("Finished executing handle webhook");
		return true;
	};

	/* ── M3 payouts ─────────────────────────────────────────── */

	override resolveBankCode = async (bankName: string): Promise<string | null> => {
		try {
			const res = await this.api.get<{ data: { code: string; name: string }[] }>(
				"/bank",
				{ params: { perPage: 100 } },
			);
			const bank = (res.data?.data ?? []).find((b: any) =>
				String(b.name ?? "").toLowerCase().includes(bankName.toLowerCase()),
			);
			return bank?.code ?? null;
		} catch (e) {
			this.log.error("Could not resolve bank code", { error: e, bankName });
			return null;
		}
	};

	/** @info - M3 withdrawal: verify an account number via /bank/resolve (free endpoint). */
	override resolveAccountNumber = async (
		accountNumber: string,
		bankCode: string,
	): Promise<{ accountNumber: string; accountName: string } | null> => {
		try {
			const res = await this.api.get<{
				data: { account_number: string; account_name: string };
			}>("/bank/resolve", {
				params: { account_number: accountNumber, bank_code: bankCode },
			});
			const d = res.data?.data;
			if (!d?.account_number) return null;
			return { accountNumber: d.account_number, accountName: d.account_name };
		} catch (e) {
			this.log.error("Could not resolve account number", { error: e });
			return null;
		}
	};

	override createRecipient = async ({
		bankCode,
		accountNumber,
		accountName,
	}: TransferRecipientOptions): Promise<{ recipientCode: string } | unknown> => {
		try {
			const res = await this.api.post<{ data: { recipient_code: string } }>(
				"/transferrecipient",
				{
					type: "nuban",
					name: accountName,
					account_number: accountNumber,
					bank_code: bankCode,
					currency: "NGN",
				},
			);
			return { recipientCode: res.data?.data?.recipient_code };
		} catch (e) {
			this.log.error("Could not create payout recipient", { error: e });
			throwBadRequestError("Could not create payout recipient");
		}
	};

	override transfer = async ({
		recipientCode,
		amount,
		reference,
	}: TransferOptions): Promise<{ status: string; transferCode: string } | unknown> => {
		try {
			const res = await this.api.post<{
				data: { transfer_code: string; status: string };
			}>(
				"/transfer",
				{
					source: "balance",
					amount,
					recipient: recipientCode,
					reference,
					currency: "NGN",
				},
			);
			return {
				status: res.data?.data?.status,
				transferCode: res.data?.data?.transfer_code,
			};
		} catch (e) {
			this.log.error("Could not initiate transfer", { error: e, reference });
			throwBadRequestError("Could not initiate transfer");
		}
	};

	/**
	 * @info - M1: idempotent instructor-crediting for charge.success.
	 *         Idempotency layers: payment.status check (app) + unique
	 *         (reference, category) on the ledger (DB) + balance row lock.
	 */
	private handleChargeSuccess = async (
		reference: string,
		_metadata?: Record<string, any>,
		data?: Record<string, any>,
	): Promise<boolean> => {
		return this.settlement.settlePayment({
			reference,
			receiptUrl: data?.receipt_url,
		});
	};
}