import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import { withTransaction } from "@/helpers/db.helper";
import { serviceLogger } from "@/utils/logger";
import {
	LedgerTransactionCategory,
	LedgerTransactionType,
	UserRole,
} from "@/enums";
import { EmailJobNames } from "@/enums";
import { EmailQueueService } from "@/services/queues/email.queue.service";
import { payments } from "../payment.model";
import { instructorBalance, instructorTransaction } from "../ledger.model";
import { courses } from "@/modules/courses/course.model";
import { communities } from "@/modules/communities/community.model";
import { communityMembers } from "@/modules/communities/community.model";
import { enrollments } from "@/modules/enrollments/enrollment.model";
import { users } from "@/modules/user/user.model";

/**
 * @class PaymentSettlementService
 * @description Idempotent settlement for a successful Paystack charge.
 * Shared by the webhook handler (primary) and the verify-settle fallback
 * (GET /payment/verify when Paystack webhooks cannot reach the server).
 * Marks the payment success, credits the instructor ledger, creates the
 * enrollment (or community membership), and queues the confirmation email.
 */
export class PaymentSettlementService {
	private static instance: PaymentSettlementService;
	private readonly log = serviceLogger("PaymentSettlement");

	static getInstance(): PaymentSettlementService {
		if (!this.instance) this.instance = new PaymentSettlementService();
		return this.instance;
	}

	private readonly emailQueue = EmailQueueService.getInstance();

	/**
	 * @param options.reference - Paystack payment reference
	 * @param options.receiptUrl - Receipt URL from the charge data
	 * @returns true when settled, false when there was nothing to do
	 */
	settlePayment = async (options: {
		reference: string;
		receiptUrl?: string | null;
	}): Promise<boolean> => {
		const { reference, receiptUrl } = options;
		if (!reference) return false;
		const db = getDb();

		const [payment] = await db
			.select()
			.from(payments)
			.where(eq(payments.reference, reference))
			.limit(1);

		/* @info - Unknown reference: keep for reconciliation, stop retries */
		if (!payment) {
			this.log.warn("Charge success for unknown reference — needs reconciliation", {
				reference,
			});
			return true;
		}

		/* @info - Duplicate webhook / verify race: already settled */
		if (payment.status === "success") {
			this.log.info("Duplicate charge settlement — already credited", { reference });
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
				/* @info - Re-check inside tx (concurrent webhooks / verify races) */
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
						receiptUrl: receiptUrl ?? payment.receiptUrl,
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

				/* @info - Grant access: enrollment for course sales, membership for community sales */
				if (payment.courseId) {
					const [existing] = await tx
						.select({ id: enrollments.id })
						.from(enrollments)
						.where(
							and(
								eq(enrollments.userId, payment.payerId),
								eq(enrollments.courseId, payment.courseId),
							),
						)
						.limit(1);
					if (!existing) {
						const [enrollment] = await tx
							.insert(enrollments)
							.values({
								userId: payment.payerId,
								courseId: payment.courseId,
							} as any)
							.returning({ id: enrollments.id });
						await tx
							.update(payments)
							.set({ enrollmentId: enrollment!.id })
							.where(eq(payments.id, payment.id));
					}
				} else if (payment.communityId) {
					const [existing] = await tx
						.select({ id: communityMembers.id })
						.from(communityMembers)
						.where(
							and(
								eq(communityMembers.userId, payment.payerId),
								eq(communityMembers.communityId, payment.communityId),
							),
						)
						.limit(1);
					if (!existing) {
						await tx.insert(communityMembers).values({
							communityId: payment.communityId,
							userId: payment.payerId,
							role: UserRole.STUDENT,
							memberRole: "member" as any,
							status: "active" as any,
						} as any);
					}
				}
			});

			/* @info - Confirmation email (outside the tx; queue failures must not roll back settlement) */
			await this.queueConfirmationEmail(payment);
		} catch (e) {
			this.log.error("Failed to settle payment", { error: e, reference });
			return false;
		}

		return true;
	};

	private queueConfirmationEmail = async (payment: any) => {
		try {
			const db = getDb();
			const [user] = await db
				.select({ email: users.email, firstName: users.firstName })
				.from(users)
				.where(eq(users.id, payment.payerId))
				.limit(1);
			if (!user?.email) return;

			let subject = "Payment received";
			let name = "Hive";
			if (payment.courseId) {
				const [course] = await db
					.select({ title: courses.title })
					.from(courses)
					.where(eq(courses.id, payment.courseId))
					.limit(1);
				subject = `You're enrolled in ${course?.title ?? "your course"}!`;
			} else if (payment.communityId) {
				const [community] = await db
					.select({ name: communities.name })
					.from(communities)
					.where(eq(communities.id, payment.communityId))
					.limit(1);
				name = community?.name ?? "Hive";
				subject = `Welcome to ${name}!`;
			}

			await this.emailQueue.add(EmailJobNames.ENROLLMENT_CONFIRMED as any, {
				message: {
					to: user.email,
					subject,
				},
				template: "enrollment-confirmed" as any,
				locals: {
					studentName: user.firstName ?? "there",
					courseName: subject.replace(/^You're enrolled in |!$/g, ""),
					communityName: name,
					enrolledAt: new Date().toLocaleDateString("en-US", {
						year: "numeric",
						month: "long",
						day: "numeric",
					}),
				},
			});
		} catch (e) {
			this.log.error("Could not queue confirmation email", { error: e, reference: payment.reference });
		}
	};
}
