import type { Context } from "hono";
import { StatusCodes } from "http-status-codes";
import { v4 as uuidv4 } from "uuid";
import { and, eq } from "drizzle-orm";
import {
	paymentCancelledPage,
	paymentSuccessPage,
	sendSuccessResponse,
} from "@/helpers";
import { throwBadRequestError, throwForbiddenError, throwNotFoundError } from "@/helpers/errors/throw-errors";
import { PaymentMessage } from "@/messages";
import { getDb } from "@/db/postgres.db";
import { courses } from "@/modules/courses/course.model";
import { communities } from "@/modules/communities/community.model";
import { users } from "@/modules/user/user.model";
import { user_roles } from "@/modules/user/user-role.model";
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
		const { type, courseId, communityId, amount } = await c.req.json();

		const db = getDb();
		const [user] = await db
			.select({ id: users.id, email: users.email })
			.from(users)
			.where(eq(users.id, Number(authData.id)))
			.limit(1);
		if (!user) throwNotFoundError("User not found");

		/* Payer role comes from user_roles (never from the JWT) */
		const [roleRow] = await db
			.select({ role: user_roles.role })
			.from(user_roles)
			.where(eq(user_roles.userId, user!.id))
			.limit(1);
		const payerRole = (roleRow?.role as string) ?? "student";

		/* Server-side price truth: exactly one of courseId | communityId,
		 * and the requested amount must equal the stored price (kobo). */
		let courseRow: { price: number | null } | undefined;
		let communityRow: { price: number | null } | undefined;
		if (type === "enrollment" && courseId) {
			[courseRow] = await db
				.select({ price: courses.price })
				.from(courses)
				.where(eq(courses.id, Number(courseId)))
				.limit(1);
			if (!courseRow) throwNotFoundError("Course not found");
			if (!courseRow!.price || courseRow!.price <= 0)
				throwBadRequestError("This course is free — no payment needed");
			if (amount !== courseRow!.price)
				throwBadRequestError("Amount does not match the course price");
		} else if (type === "community" && communityId) {
			[communityRow] = await db
				.select({ price: communities.price })
				.from(communities)
				.where(eq(communities.id, Number(communityId)))
				.limit(1);
			if (!communityRow) throwNotFoundError("Community not found");
			if (!communityRow!.price || communityRow!.price <= 0)
				throwBadRequestError("This community is free — no payment needed");
			if (amount !== communityRow!.price)
				throwBadRequestError("Amount does not match the community price");
		} else {
			throwBadRequestError("Either courseId or communityId is required");
		}

		const reference = `hive-${uuidv4()}`;

		/** @info - Create pending payment row (payerRole + real email; courseId/communityId set) */
		await this.paymentRepo.create({
			payerId: Number(authData.id),
			payerRole,
			enrollmentId: null,
			courseId: courseId ? Number(courseId) : null,
			communityId: communityId ? Number(communityId) : null,
			studentId: Number(authData.id),
			amount,
			platformFee: Math.round(amount * 0.1),
			type,
			reference,
			status: "pending",
		} as any);

		/** @info - Initialize Paystack transaction */
		const result = await this.paystackService.initializeTransaction({
			email: user!.email,
			amount,
			reference,
			metadata: {
				paymentType: type,
				courseId: courseId ?? null,
				communityId: communityId ?? null,
				studentId: authData.id,
				payerId: authData.id,
			},
		} as any);

		return sendSuccessResponse(c, {
			authorizationUrl: (result as any).data?.authorization_url,
			reference,
		});
	};

	/** @info - Payment status for the checkout/confirmation page (owner-scoped) */
	verifyPayment = async (c: Context) => {
		const authData = c.get("authData");
		const reference = c.req.param("reference") as string;

		const payment = await this.paymentRepo.findByReference(reference);
		if (!payment) throwNotFoundError("Payment not found");
		if (payment!.payerId !== Number(authData.id))
			throwForbiddenError("This payment belongs to another user");

		return sendSuccessResponse(c, {
			status: payment!.status,
			type: payment!.type,
			amount: payment!.amount,
			platformFee: payment!.platformFee,
			reference: payment!.reference,
			receiptUrl: payment!.receiptUrl,
			courseId: payment!.courseId,
			communityId: payment!.communityId,
			createdAt: payment!.createdAt,
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
