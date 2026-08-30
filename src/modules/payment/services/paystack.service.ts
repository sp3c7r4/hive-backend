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
		if (!reference) return false;
		const db = getDb();

		const [payment] = await db
			.select()
			.from(payments)
			.where(eq(payments.reference, reference))
			.limit(1);

		/* @info - Unknown reference: keep for reconciliation, let Paystack stop retrying */
		if (!payment) {
			this.log.warn("Charge success for unknown reference — needs reconciliation", {
				reference,
			});
			return true;
		}

		/* @info - Duplicate webhook: already handled */
		if (payment.status === "success") {
			this.log.info("Duplicate charge webhook — already credited", { reference });
			return true;
		}

		/* @info - Resolve payee: course sale → course.instructorId; community sale → owner */
		let payeeId: number | null = null;
		let category: LedgerTransactionCategory = LedgerTransactionCategory.ENROLLMENT;
		if (payment.courseId) {
			const [course] = await db
				.select({ instructorId: courses.instructorId })
				.from(courses)
				.where(eq(courses.id, payment.courseId))
				.limit(1);
			payeeId = course?.instructorId ?? null;
			category = LedgerTransactionCategory.ENROLLMENT;
		} else if (payment.communityId) {
			const [community] = await db
				.select({ ownerId: communities.ownerId })
				.from(communities)
				.where(eq(communities.id, payment.communityId))
				.limit(1);
			payeeId = community?.ownerId ?? null;
			category = LedgerTransactionCategory.COMMUNITY;
		}

		const net = Math.max(0, (payment.amount ?? 0) - (payment.platformFee ?? 0));

		try {
			await withTransaction(async (tx) => {
				/* @info - Re-check inside tx (concurrent webhooks) */
				const [again] = await tx
					.select()
					.from(payments)
					.where(eq(payments.reference, reference))
					.limit(1);
				if (again?.status === "success") return;

				await tx
					.update(payments)
					.set({
						status: "success" as any,
						receiptUrl: data?.receipt_url ?? payment.receiptUrl,
					})
					.where(eq(payments.reference, reference));

				if (!payeeId) {
					this.log.warn(
						"Charge success without resolvable payee — needs reconciliation",
						{ reference },
					);
					return;
				}

				/* @info - Balance row lock: serialize concurrent credits */
				const [balance] = await tx
					.select()
					.from(instructorBalance)
					.where(eq(instructorBalance.instructorId, payeeId))
					.for("update")
					.limit(1);

				const nextAvailable = (balance?.available ?? 0) + net;
				if (balance) {
					await tx
						.update(instructorBalance)
						.set({ available: nextAvailable })
						.where(eq(instructorBalance.id, balance.id));
				} else {
					await tx.insert(instructorBalance).values({
						instructorId: payeeId,
						available: nextAvailable,
						withdrawn: 0,
					});
				}

				await tx.insert(instructorTransaction).values({
					instructorId: payeeId,
					type: LedgerTransactionType.CREDIT,
					category,
					amount: net,
					balanceAfter: nextAvailable,
					reference,
					paymentId: payment.id,
					description:
						category === LedgerTransactionCategory.COMMUNITY
							? "Community sale (net)"
							: "Course sale (net)",
				});
			});
		} catch (e) {
			this.log.error("Failed to credit instructor ledger", { error: e, reference });
		}

		return true;
	};
}
