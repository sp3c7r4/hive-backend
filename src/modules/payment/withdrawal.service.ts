import { and, desc, eq, inArray } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "@/db/postgres.db";
import { config } from "@/config";
import { withTransaction } from "@/helpers/db.helper";
import {
	throwBadRequestError,
	throwNotFoundError,
	throwConflictError,
} from "@/helpers/errors/throw-errors";
import type { IAuthData } from "@/interfaces/auth/auth.interface";
import { LedgerTransactionCategory, LedgerTransactionType } from "@/enums";
import { instructorBalance, instructorTransaction } from "./ledger.model";
import { withdrawals, type Withdrawal } from "./payment.model";
import { users } from "@/modules/user/user.model";
import { PaystackService } from "./services";
import { NotificationService } from "@/modules/notifications";
import { NotificationType } from "@/enums";
import { BadRequestError } from "@/errors";
import { logger } from "@/utils";

/** @info - Minimum withdrawal: ₦1,000 (kobo). */
export const MIN_WITHDRAWAL_KOBO = 100_000;

/** @info - Note written when the kill switch suppresses a payout: the row still
 * advances, but no Paystack recipient/transfer was created. */
export const TRANSFER_SUPPRESSED_NOTE = "transfer suppressed (non-prod)";

export class WithdrawalService {
	private static instance: WithdrawalService;
	private readonly paystack = PaystackService.getInstance();

	static getInstance(): WithdrawalService {
		if (!this.instance) this.instance = new WithdrawalService();
		return this.instance;
	}

	private constructor() {}

	/* @info - Hold the balance: withdraw amount out of `available` inside a tx. */
	create = async (
		authData: IAuthData,
		body: { amount: number; bankName: string; accountNumber: string; accountName: string },
	) => {
		const userId = Number(authData.id);
		const { amount, bankName, accountNumber, accountName } = body;

		if (amount < MIN_WITHDRAWAL_KOBO)
			throwBadRequestError(`Minimum withdrawal is ₦${MIN_WITHDRAWAL_KOBO / 100}`);
		if (!/^\d{10}$/.test(accountNumber))
			throwBadRequestError("Account number must be 10 digits");

		const reference = `wd-${uuidv4()}`;

		return withTransaction(async (tx) => {
			const [balance] = await tx
				.select()
				.from(instructorBalance)
				.where(eq(instructorBalance.instructorId, userId))
				.for("update")
				.limit(1);

			if (!balance || balance!.available < amount)
				throwBadRequestError("Insufficient balance");

			const nextAvailable = balance!.available - amount;
			await tx
				.update(instructorBalance)
				.set({ available: nextAvailable })
				.where(eq(instructorBalance.id, balance!.id));

			const [row] = await tx
				.insert(withdrawals)
				.values({
					instructorId: userId,
					amount,
					bankName,
					accountNumber,
					accountName,
					status: "pending" as any,
					reference,
				})
				.returning();

			await tx.insert(instructorTransaction).values({
				instructorId: userId,
				type: LedgerTransactionType.DEBIT,
				category: LedgerTransactionCategory.WITHDRAWAL,
				amount,
				balanceAfter: nextAvailable,
				reference,
				withdrawalId: row!.id,
				description: "Withdrawal hold",
			});

			return row;
		});
	};

	/* @info - Verify a bank account with Paystack before withdrawal. The bank CODE
	 *         from the picker is the identity; the name→code lookup only runs for
	 *         legacy callers that still send a bank name. */
	verifyAccount = async (
		authData: IAuthData,
		body: { bankName?: string; bankCode?: string; accountNumber: string },
	) => {
		const { bankName, accountNumber } = body;
		if (!/^\d{10}$/.test(accountNumber))
			throwBadRequestError("Account number must be 10 digits");

		const bankCode =
			body.bankCode ?? (bankName ? await this.bankCodeFor(bankName) : null);
		/* @info - Guarded with a real throw (not the helper) so TS narrows the
		 *         code below to a string. */
		if (!bankCode)
			throw new BadRequestError("Select a bank and enter a 10-digit account number");

		const resolved = await this.paystack.resolveAccountNumber(
			accountNumber,
			bankCode,
		);

		/* @info - Dev-only fallback: Paystack test-mode does not resolve NUBANs for
		 *         every key. Never enable outside development (env flag). */
		if (!resolved) {
			if (config.paystack.devResolveFallback) {
				return {
					bankName,
					bankCode,
					accountNumber,
					accountName: "Test Account",
					simulated: true,
				};
			}
			throwBadRequestError(
				"Could not verify this account. Check the bank and account number.",
			);
		}

		return {
			bankName,
			bankCode,
			accountNumber: resolved!.accountNumber,
			accountName: resolved!.accountName,
			/* @info - Test keys cannot resolve real NUBANs (code 001), so a name that
			 * came from one is simulated — the UI must not present it as verified. */
			simulated: this.isTestMode(),
		};
	};

	/** @info - Payout institutions for the withdrawal picker (upstream cached). */
	listBanks = async () => this.paystack.listBanks();

	listMine = async (authData: IAuthData, params?: { page?: number; limit?: number }) => {
		const db = getDb();
		const page = Math.max(1, Number(params?.page) || 1);
		const limit = Math.max(1, Math.min(Number(params?.limit) || 30, 100));

		const rows = await db
			.select()
			.from(withdrawals)
			.where(eq(withdrawals.instructorId, Number(authData.id)))
			.orderBy(desc(withdrawals.requestedAt))
			.limit(limit)
			.offset((page - 1) * limit);

		return { items: rows, meta: { page, limit } };
	};

	listAdmin = async (params?: { status?: string; page?: number; limit?: number }) => {
		const db = getDb();
		const page = Math.max(1, Number(params?.page) || 1);
		const limit = Math.max(1, Math.min(Number(params?.limit) || 30, 100));

		const where = params?.status
			? [eq(withdrawals.status, params.status as any)]
			: [];

		const rows = await db
			.select({
				id: withdrawals.id,
				instructorId: withdrawals.instructorId,
				firstName: users.firstName,
				lastName: users.lastName,
				email: users.email,
				amount: withdrawals.amount,
				bankName: withdrawals.bankName,
				accountNumber: withdrawals.accountNumber,
				status: withdrawals.status,
				reference: withdrawals.reference,
				requestedAt: withdrawals.requestedAt,
				processedAt: withdrawals.processedAt,
			})
			.from(withdrawals)
			.innerJoin(users, eq(withdrawals.instructorId, users.id))
			.where(where.length ? and(...where) : undefined as any)
			.orderBy(desc(withdrawals.requestedAt))
			.limit(limit)
			.offset((page - 1) * limit);

		return { items: rows, meta: { page, limit } };
	};

	/** @info - Admin approve: resolve bank → recipient → transfer (idempotent by
	 *         reference). The whole payout is suppressed when the kill switch is
	 *         off (non-prod, where the live keys would move real money): the row
	 *         still advances so the status machine matches production. */
	approve = async (id: number) => {
		const db = getDb();
		const [w] = await db
			.select()
			.from(withdrawals)
			.where(eq(withdrawals.id, id))
			.limit(1);
		if (!w) throwNotFoundError("Withdrawal not found");
		if (w!.status !== "pending")
			throwConflictError("Withdrawal is no longer pending");

		if (!config.paystack.withdrawalsTransferEnabled) {
			logger.warn("Withdrawal transfer suppressed (non-prod)", {
				withdrawalId: w!.id,
				reference: w!.reference,
			});
			await this.settle(w!, "processing", TRANSFER_SUPPRESSED_NOTE);
			return { status: "processing", transferSuppressed: true };
		}

		try {
			const bankCode = await this.bankCodeFor(w!.bankName);
			/* @info - No bank, no payout: a guessed code silently pays the wrong
			 *         destination, so fail the row and refund the hold instead. */
			if (!bankCode) {
				const reason = `Could not resolve the bank for "${w!.bankName}"`;
				await this.failAndRefund(w!, new Error(reason));
				return { status: "failed", transferError: reason };
			}

			const recipient = (await this.paystack.createRecipient({
				bankCode,
				accountNumber: w!.accountNumber,
				accountName: w!.accountName,
			})) as { recipientCode: string };
			const transfer = (await this.paystack.transfer({
				recipientCode: recipient.recipientCode,
				amount: w!.amount,
				reference: w!.reference,
			})) as { status: string; transferCode: string };

			const status =
				transfer.status === "success"
					? "completed"
					: transfer.status === "pending" || transfer.status === "processing"
						? "processing"
						: "completed";

			await this.settle(w!, status);
			return { status, transferCode: transfer.transferCode };
		} catch (e) {
			/* Paystack failure → failed + refund the hold; surface the outcome
			 * instead of throwing (the money is already safe). */
			await this.failAndRefund(w!, e);
			return {
				status: "failed",
				transferError: e instanceof Error ? e.message : String(e),
			};
		}
	};

	/** @info - Post-transfer bookkeeping, shared by the real and the suppressed
	 *         path so a non-prod row is indistinguishable from a prod one apart
	 *         from its note: status, lifetime-withdrawn, instructor notice. */
	private settle = async (
		w: Withdrawal,
		status: string,
		note?: string,
	) => {
		const db = getDb();
		await db
			.update(withdrawals)
			.set({
				status: status as any,
				processedAt: new Date(),
				...(note ? { note } : {}),
			})
			.where(eq(withdrawals.id, w.id));

		/* @info - Money out of the balance → lifetime withdrawn */
		await withTransaction(async (tx) => {
			const [balance] = await tx
				.select()
				.from(instructorBalance)
				.where(eq(instructorBalance.instructorId, w.instructorId))
				.for("update")
				.limit(1);
			if (balance) {
				await tx
					.update(instructorBalance)
					.set({ withdrawn: (balance.withdrawn ?? 0) + w.amount })
					.where(eq(instructorBalance.id, balance!.id));
			}
		});

		NotificationService.getInstance().notify(
			w.instructorId,
			NotificationType.PAYMENT,
			"Withdrawal approved",
			`Your withdrawal of ₦${Math.round(Number(w.amount ?? 0) / 100).toLocaleString("en-US")} was sent to ${w.bankName}`,
			{ withdrawalId: w.id },
		);
	};

	/** @info - Admin reject: release the hold back into available. */
	reject = async (id: number) => {
		const db = getDb();
		const [w] = await db
			.select()
			.from(withdrawals)
			.where(eq(withdrawals.id, id))
			.limit(1);
		if (!w) throwNotFoundError("Withdrawal not found");
		if (w!.status !== "pending")
			throwConflictError("Withdrawal is no longer pending");

		await db
			.update(withdrawals)
			.set({ status: "rejected" as any, processedAt: new Date() })
			.where(eq(withdrawals.id, id));

		await this.refundHold(w!, "rejected");

		NotificationService.getInstance().notify(
			w!.instructorId,
			NotificationType.PAYMENT,
			"Withdrawal rejected",
			`Your withdrawal of ₦${Math.round(Number(w!.amount ?? 0) / 100).toLocaleString("en-US")} was declined. The funds are back in your balance.`,
			{ withdrawalId: w!.id },
		);
		return { status: "rejected" };
	};

	/* ── Internals ──────────────────────────────────────────── */

	/** @info - Paystack test mode cannot resolve real NUBANs; use test bank code
	 *         001 there (resolves any account as TEST ACCOUNT x). Production
	 *         keys resolve the real bank from the cached /bank list. */
	private isTestMode = () => config.paystack.secret.startsWith("sk_test_");

	/** @info - Bank name → code, or null when the name is unknown/ambiguous:
	 *         guessing a code means guessing a payout destination, so callers
	 *         fail loudly instead (the old `?? "044"` default routed anything
	 *         unrecognised to GTBank). */
	private bankCodeFor = async (bankName: string): Promise<string | null> =>
		this.isTestMode() ? "001" : await this.paystack.resolveBankCode(bankName);

	private refundHold = async (
		w: { id: number; instructorId: number; amount: number; reference: string },
		reason: "rejected" | "failed",
	) => {
		await withTransaction(async (tx) => {
			const [balance] = await tx
				.select()
				.from(instructorBalance)
				.where(eq(instructorBalance.instructorId, w!.instructorId))
				.for("update")
				.limit(1);

			const nextAvailable = (balance?.available ?? 0) + w.amount;
			if (balance) {
				await tx
					.update(instructorBalance)
					.set({ available: nextAvailable })
					.where(eq(instructorBalance.id, balance!.id));
			} else {
				await tx.insert(instructorBalance).values({
					instructorId: w.instructorId,
					available: nextAvailable,
					withdrawn: 0,
				});
			}

			await tx.insert(instructorTransaction).values({
				instructorId: w.instructorId,
				type: LedgerTransactionType.CREDIT,
				category: LedgerTransactionCategory.WITHDRAWAL_REFUND,
				amount: w!.amount,
				balanceAfter: nextAvailable,
				reference: w!.reference,
				withdrawalId: w.id,
				description: `Withdrawal ${reason} — refund`,
			});
		});
	};

	private failAndRefund = async (
		w: { id: number; instructorId: number; amount: number; reference: string },
		e: unknown,
	) => {
		const db = getDb();
		await db
			.update(withdrawals)
			.set({ status: "failed" as any, processedAt: new Date() })
			.where(eq(withdrawals.id, w.id));
		await this.refundHold(w, "failed");
	};
}
