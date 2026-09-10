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
import { CacheService } from "@/services/cache.service";
import { TTL } from "@/constants";
import { PaymentGatewayService } from "./payment-gateway.service";
import { PaymentSettlementService } from "./payment-settlement.service";

const PaystackBaseUrl = "https://api.paystack.co";

/** @info - NGN payout institutions (see listBanks). The list is identical for
 * staging and prod, so the KEYS are shared rather than env-scoped. */
const BANKS_CACHE_KEY = "payments:paystack:banks:ngn";
const BANKS_LAST_GOOD_KEY = "payments:paystack:banks:ngn:last-good";

export interface PaystackBank {
	name: string;
	code: string;
}

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

	/** @info - NGN payout institutions for the withdrawal picker. Paystack
	 *         returns the whole list (≈283) in ONE call — pagination params are
	 *         ignored there, so no page loop. Cached 24h; the last-good copy is
	 *         written without a TTL so a cold cache during an upstream outage
	 *         still serves a usable picker instead of an empty dropdown. */
	listBanks = async (): Promise<PaystackBank[]> => {
		const cache = CacheService.getInstance();
		const cached = await cache.get<PaystackBank[]>(BANKS_CACHE_KEY);
		if (cached?.length) return cached;

		try {
			/* @info - Literal path: PaystackPaths is a type-only import, so the
			 *         interface cannot be read at runtime (same reason every other
			 *         call in this file uses the literal). */
			const res = await this.api.get<{ data: PaystackBank[] }>("/bank", {
				params: { country: "nigeria", currency: "NGN" },
			});
			const banks = this.normaliseBanks(res.data?.data ?? []);
			if (banks.length) {
				await cache.set(BANKS_CACHE_KEY, banks, TTL.IN_24_HOURS);
				await cache
					.getRedisClient()
					.set(BANKS_LAST_GOOD_KEY, JSON.stringify(banks));
			}
			return banks;
		} catch (e) {
			this.log.error("Could not fetch Paystack banks", { error: e });
			return (await cache.get<PaystackBank[]>(BANKS_LAST_GOOD_KEY)) ?? [];
		}
	};

	/** @info - Dedupe by code (Paystack lists a few institutions twice) and sort
	 *         by name so the picker's order is stable between calls. */
	private normaliseBanks = (banks: PaystackBank[]): PaystackBank[] => {
		const byCode = new Map<string, PaystackBank>();
		for (const bank of banks) {
			const code = String(bank?.code ?? "").trim();
			const name = String(bank?.name ?? "").trim();
			if (!code || !name) continue;
			if (!byCode.has(code)) byCode.set(code, { name, code });
		}
		return [...byCode.values()].sort((a, b) => a.name.localeCompare(b.name));
	};

	/** @info - Bank name → code. Requires an EXACT (case-insensitive) match
	 *         first: the old first-substring match silently picked the wrong
	 *         institution when one name contains another (e.g. "Access Bank"
	 *         inside "Access Bank (Diamond)"), which would send a transfer to a
	 *         different bank than the instructor chose. A UNIQUE substring is
	 *         still accepted for legacy hand-typed names; ambiguous ones fail. */
	override resolveBankCode = async (bankName: string): Promise<string | null> => {
		try {
			const banks = await this.listBanks();
			if (!banks.length) return null;

			const needle = bankName.trim().toLowerCase();
			const exact = banks.find((b) => b.name.toLowerCase() === needle);
			if (exact) return exact.code;

			const partial = banks.filter((b) => b.name.toLowerCase().includes(needle));
			if (partial.length === 1) return partial[0]!.code;

			this.log.warn("Bank name did not resolve to exactly one institution", {
				bankName,
				matches: partial.length,
			});
			return null;
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