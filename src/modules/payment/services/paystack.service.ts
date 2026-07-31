import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { RelationalRepository } from "@/bases";
import { config } from "@/config";
import {
	CreditTransactionType,
	ModelCollections,
	OrderStatus,
	PaymentAction,
	PaymentChannel,
	PaymentServiceProvider,
	PaymentStatus,
	type PlanName,
	PlanSubscriptionStatus,
	type GenerateReceiptOptions,
} from "@/enums";
import { PaystackEvents, type PaystackPaths } from "@/enums/billing/paystack";
import { getPlanByName } from "@/helpers/billing/billing.helper";
import { PlanHandler } from "@/helpers/billing/plan.handler";
import { computeSubscriptionDates } from "@/helpers/business/business.helper";
import { throwBadRequestError } from "@/helpers/errors/throw-errors";
import { withTransaction } from "@/helpers/db.helper";
import type {
	HandleWebhookOptions,
	InitializeTransactionOptions,
	InitializeTransactionResult,
	VerifyTransactionOptions,
	VerifyTransactionResult,
} from "@/interfaces";
import { CreditBalanceMessages, SubscriptionMessages } from "@/messages";
import {
	creditBalance,
	creditTransaction,
	payment,
	subscription,
} from "@/models/billing";
import { ApiService } from "../../../services/api.service";
import { PaymentGatewayService } from "./payment-gateway.service";
import {
	order,
	orderItem,
	orderPayment,
	type OrderPaymentMetadata,
} from "@/modules/commerce/order/order.model";
import { business } from "@/modules/business/models/business.model";
import { contact } from "@/modules/contact/models/contact.model";
import { contactBusiness } from "@/modules/contact/models/contact-bridge-business.model";
import { getDb } from "@/db/postgres.db";
import { ReceiptQueueService } from "@/services/queues/receipt.queue.service";

interface Metadata {
	action: PaymentAction;
	trackingCode: string;
	businessId: number;
	planName?: PlanName;
}

interface HandleMetadataRouting {
	event: PaystackEvents;
	metadata: Metadata;
	customerCode: string;
	channel: PaymentChannel;
}

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
			throwBadRequestError("Error initializing transaction");
		}
	};

	override handleWebhook = async (
		options: HandleWebhookOptions,
	): Promise<boolean> => {
		const { paystack_signature, body } = options;
		console.log(paystack_signature, body);
		const hash = crypto
			.createHmac("sha512", config.paystack.secret)
			.update(JSON.stringify(body))
			.digest("hex");

		if (hash === paystack_signature) {
			this.log.info(
				`Webhook recieved successfully from ${body.data.ip_address}`,
			);

			const event = body.event;
			console.dir(body);

			/** @info - Paystack Event handler */
			switch (event) {
				case PaystackEvents.CHARGE_SUCCESS: {
					return await this.handleRouting({
						event,
						customerCode: body.data.customer.customer_code,
						metadata: body.data.metadata,
						channel: body.data.channel,
					});
				}
				default:
					return false;
			}
		}

		this.log.info(`Finished executing handle webhook`);

		return true;
	};

	private async handleRouting(
		options: HandleMetadataRouting,
	): Promise<boolean> {
		const { metadata, customerCode, event } = options;
		const { action, trackingCode, businessId, ...rest } = metadata;

		this.log.info(`Routing to ${action}`);
		switch (action) {
			case PaymentAction.UPGRADE_PLAN: {
				if (!rest.planName) return false;

				try {
					await withTransaction(async (tx) => {
						const pRepo = new RelationalRepository(payment, tx);
						const sRepo = new RelationalRepository(subscription, tx);
						const creditBalanceRepo = new RelationalRepository(
							creditBalance,
							tx,
						);
						const creditTransactionRepo = new RelationalRepository(
							creditTransaction,
							tx,
						);

						/** @info - Idempotency check if the payment has been handled before */
						const existingPayment = await pRepo.findOne(
							eq(payment.trackingCode, trackingCode),
						);

						// Already processed — bail out silently
						if (existingPayment?.status === PaymentStatus.SUCCESS) {
							this.log.warn(
								`Duplicate webhook for trackingCode: ${metadata.trackingCode}`,
							);
							return;
						}

						/** @info - Fetch Plan */
						const getPlan = await getPlanByName(metadata.planName as PlanName);
						if (!getPlan) return false;

						/** @info - Update Payment Status and Customer Code */
						await pRepo.updateWhere(
							eq(payment.trackingCode, metadata.trackingCode),
							{
								status: PaymentStatus.SUCCESS,
								paystackCustomerCode: customerCode,
								creditsGranted: getPlan.creditsIncluded,
							},
						);

						/** @info - Compute subscription month */
						const { start, end } = computeSubscriptionDates(1);

						/** @info - Upsert Subscription (unique on businessId) */
						const createdSubscription = await sRepo.upsert(
							eq(subscription.businessId, businessId),
							{
								businessId,
								planId: getPlan.id,
								status: PlanSubscriptionStatus.ACTIVE,
								currentPeriodStart: start,
								currentPeriodEnd: end,
								paystackSubscriptionCode: null,
							} as any,
						);

						/** @info - Add to credit Balance */
						const fetchBalance = await creditBalanceRepo.findOne(
							eq(creditBalance.businessId, metadata.businessId),
						);

						if (!fetchBalance) {
							this.log.error(
								`${CreditBalanceMessages.NOT_FOUND} for ${metadata.businessId}`,
							);
							/* This rolls back the whole transaction when no balance record not found */
							throw new Error(CreditBalanceMessages.NOT_FOUND);
						}

						const [updatedCreditBalance] = await creditBalanceRepo.updateWhere(
							eq(creditBalance.businessId, metadata.businessId),
							{
								balance: fetchBalance.balance + getPlan.creditsIncluded,
							},
						);

						if (!updatedCreditBalance)
							throw new Error(CreditBalanceMessages.NOT_FOUND);

						/** Updating our Ledger - Write only */
						await creditTransactionRepo.create({
							businessId: metadata.businessId,
							amount: getPlan.creditsIncluded,
							balanceAfter: updatedCreditBalance.balance,
							type: CreditTransactionType.TOPUP,
							refrenceId: createdSubscription.id,
							refrenceType: ModelCollections.SUBSCRIPTION,
							description: SubscriptionMessages.CREDIT_TRANSACTION(
								rest.planName!,
							),
						});

					this.log.info(`Business upgraded successfully`, { businessId });
					});
					this.log.info(
						`Processed upgrade plan for business with ID:${businessId} successfully`,
					);

					// Unpause bots that were auto-paused due to credit exhaustion
					await PlanHandler.getInstance().resumeAfterTopup(businessId);

					return true;
				} catch (e) {
					const message: string = e instanceof Error ? e.message : String(e);
					this.log.error(message, { error: e });
					return true;
				}
			}
			case PaymentAction.PLACE_ORDER: {
				const payment = await withTransaction(async (tx) => {
					const orderRepo = new RelationalRepository(order, tx);
					const orderPaymentRepo = new RelationalRepository(orderPayment, tx);

					/** @info - Idempotency check if the payment has been handled before */
					const existingPayment = await orderPaymentRepo.findOne(
						eq(orderPayment.trackingCode, trackingCode),
					);

					// Already processed — bail out silently
					if (existingPayment?.status === PaymentStatus.SUCCESS) {
						this.log.warn(
							`Duplicate webhook for trackingCode: ${metadata.trackingCode}`,
						);
						return null;
					}

					const [updatedPayment] = await orderPaymentRepo.updateWhere(
						eq(orderPayment.trackingCode, trackingCode),
						{
							status: PaymentStatus.SUCCESS,
							paymentProviderCustomerCode: customerCode,
							paidAt: new Date(),
						},
					);

					if (!updatedPayment) {
						this.log.error(
							`No payment found for trackingCode: ${trackingCode}`,
						);
						return null;
					}

					await orderRepo.updateWhere(eq(order.id, updatedPayment.orderId), {
						status: OrderStatus.CONFIRMED,
					});
					this.log.info(`Order processed successfully.`, { trackingCode });

					return updatedPayment;
				});

				if (!payment) break;

				this.log.info(
					`Processed order for business with ID:${businessId} and Tracking Code ${trackingCode} successfully`,
				);

				// Dispatch receipt if routing metadata is present
				const meta = payment.metadata;
				if (meta?.connectionId && meta?.senderId) {
					await this.dispatchReceipt(payment, {
						connectionId: meta.connectionId,
						senderId: meta.senderId,
					});
				}

				break;
			}
			default:
				return false;
		}

		this.log.info(`Finished handling payment webhook with event ${event}`);
		return true;
	}

	private async dispatchReceipt(
		payment: typeof orderPayment.$inferSelect,
		meta: OrderPaymentMetadata,
	) {
		const db = getDb();

		try {
			// Look up the order to get contactBusinessId
			const [ord] = await db
				.select()
				.from(order)
				.where(eq(order.id, payment.orderId));

			// Look up order items
			const items = await db
				.select()
				.from(orderItem)
				.where(eq(orderItem.orderId, payment.orderId));

			// Look up business
			const [biz] = await db
				.select()
				.from(business)
				.where(eq(business.id, payment.businessId));

			// Look up customer name via order.contactBusinessId → contactBusiness → contact
			let customerName = "Customer";
			if (ord?.contactBusinessId) {
				const [cb] = await db
					.select()
					.from(contactBusiness)
					.where(eq(contactBusiness.id, ord.contactBusinessId));

				if (cb) {
					const [ct] = await db
						.select()
						.from(contact)
						.where(eq(contact.id, cb.contactId));
					customerName = ct?.displayName || ct?.firstName || "Customer";
				}
			}

			const receiptOptions: GenerateReceiptOptions = {
				receiptNumber: payment.trackingCode,
				receiptDate: new Date().toISOString(),
				business: {
					name: biz?.name ?? "Business",
				},
				customer: { name: customerName },
				products: items.map((item) => ({
					description: item.productNameSnapShot ?? `Product #${item.productId}`,
					quantity: item.quantity,
					unitPrice: item.unitPrice ?? 0,
				})),
				connectionId: meta.connectionId,
				senderId: meta.senderId,
			};

			await ReceiptQueueService.getInstance().add(
				"send-receipt",
				receiptOptions,
			);

			this.log.info(
				`Receipt job dispatched for trackingCode: ${payment.trackingCode}`,
			);
		} catch (error) {
			this.log.error(
				`Failed to dispatch receipt for trackingCode: ${payment.trackingCode}`,
				{ error },
			);
		}
	}
}
