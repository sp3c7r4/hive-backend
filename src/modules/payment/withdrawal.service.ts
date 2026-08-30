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
import { withdrawals } from "./payment.model";
import { users } from "@/modules/user/user.model";
import { PaystackService } from "./services";

/** @info - Minimum withdrawal: ₦1,000 (kobo). */
export const MIN_WITHDRAWAL_KOBO = 100_000;

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

	/* @info - Verify a bank account with Paystack before withdrawal. Returns the
	 *         owner name as recorded at the bank — the withdrawal uses it. */
	verifyAccount = async (
		authData: IAuthData,
		body: { bankName: string; accountNumber: string },
	) => {
		const { bankName, accountNumber } = body;
		if (!/^\d{10}$/.test(accountNumber))
			throwBadRequestError("Account number must be 10 digits");

		const bankCode = (await this.paystack.resolveBankCode(bankName)) ?? "044";
		const resolved = await this.paystack.resolveAccountNumber(accountNumber, bankCode);

		/* @info - Dev-only fallback: Paystack test-mode does not resolve NUBANs for
		 *         every key. Never enable outside development (env flag). */
		if (!resolved) {
			if (config.paystack.devResolveFallback) {
				const fallback = {
					bankName,
					bankCode,
					accountNumber,
					accountName: "Test Account",
				};
				return fallback;
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
		};
	};

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

	/** @info - Admin approve: resolve bank → recipient → transfer (idempotent by reference). */
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

		try {
			const bankCode = (await this.paystack.resolveBankCode(w!.bankName)) ?? "044";
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

			await db
				.update(withdrawals)
				.set({ status: status as any, processedAt: new Date() })
				.where(eq(withdrawals.id, id));

			/* @info - Money out of the balance → lifetime withdrawn */
			await withTransaction(async (tx) => {
				const [balance] = await tx
					.select()
					.from(instructorBalance)
					.where(eq(instructorBalance.instructorId, w!.instructorId))
					.for("update")
					.limit(1);
				if (balance) {
					await tx
						.update(instructorBalance)
						.set({ withdrawn: (balance.withdrawn ?? 0) + w!.amount })
						.where(eq(instructorBalance.id, balance!.id));
				}
			});

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
		return { status: "rejected" };
	};

	/* ── Internals ──────────────────────────────────────────── */

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
