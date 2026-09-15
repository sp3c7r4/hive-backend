import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
	const results: any[] = [];
	const records: any[] = [];

	const fixed = { ok: true };
	/* @info - Queue-consume ONLY at select terminals + withdrawal returning */
	const thenable = {
		then: async (resolve: any) => resolve(results.shift() ?? []),
	};
	const fixedThenable = {
		then: async (resolve: any) => resolve(fixed),
	};

	const updateHandler = (payload: any) => ({
		where: () => {
			records.push({ kind: "update", payload });
			return fixedThenable;
		},
	});

	const chain: any = {
		select: () => chain,
		from: () => chain,
		innerJoin: () => chain,
		where: () => chain,
		orderBy: () => chain,
		for: () => chain,
		groupBy: () => chain,
		limit: () => ({
			offset: async () => results.shift() ?? [],
			then: async (resolve: any) => resolve(results.shift() ?? []),
		}),
		then: async (resolve: any) => resolve(results.shift() ?? []),
		update: () => ({ set: updateHandler }),
	};

	const tx = {
		select: () => chain,
		update: () => ({ set: updateHandler }),
		insert: () => ({
			values: (payload: any) => {
				records.push({ kind: "insert", payload });
				return { returning: () => thenable };
			},
		}),
		delete: () => ({ where: () => fixedThenable }),
	};

	const paystack = {
		resolveBankCode: vi.fn(async () => "044"),
		resolveAccountNumber: vi.fn(async () => ({ accountNumber: "0123456789", accountName: "SARAFTA SATAE" })),
		createRecipient: vi.fn(async () => ({ recipientCode: "RCP_test" })),
		transfer: vi.fn(async () => ({ status: "success", transferCode: "TRF_test" })),
		listBanks: vi.fn(async () => [{ name: "GTBank", code: "058" }]),
	};

	/* @info - Mutable paystack config so the kill switch and the test-key/live-key
	 * branches are exercised deterministically (the ambient .env holds LIVE keys,
	 * which is what made the old test-mode expectations fail). */
	const paystackConfig = {
		secret: "sk_test_x",
		devResolveFallback: true,
		withdrawalsTransferEnabled: true,
	};

	/* @info - Email queue + in-app notify are fire-and-forget side effects. The
	 * notify mock also keeps the mocked DB result queue deterministic: the real
	 * one selects a role row and would race our own user lookup for a result. */
	const emailAdd = vi.fn(async (_jobName: string, _data: any) => undefined);
	const emailQueue = { add: emailAdd };
	const notify = vi.fn(async () => undefined);

	return {
		db: chain,
		tx,
		paystack,
		paystackConfig,
		results,
		records,
		emailAdd,
		emailQueue,
		notify,
	};
});

vi.mock("@/services/queues/email.queue.service", () => ({
	EmailQueueService: { getInstance: () => mocks.emailQueue },
}));

vi.mock("@/modules/notifications", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/modules/notifications")>();
	return {
		...actual,
		NotificationService: { getInstance: () => ({ notify: mocks.notify }) },
	};
});

vi.mock("@/config", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/config")>();
	const paystack = {
		...actual.config.paystack,
		get secret() {
			return mocks.paystackConfig.secret;
		},
		get devResolveFallback() {
			return mocks.paystackConfig.devResolveFallback;
		},
		get withdrawalsTransferEnabled() {
			return mocks.paystackConfig.withdrawalsTransferEnabled;
		},
	};
	return { config: { ...actual.config, paystack } };
});

vi.mock("@/db/postgres.db", () => ({ getDb: () => mocks.db }));
vi.mock("@/helpers/db.helper", () => ({
	withTransaction: (fn: any) => fn(mocks.tx),
}));
vi.mock("@/modules/payment/services/paystack.service", () => ({
	PaystackService: { getInstance: () => mocks.paystack },
}));

async function loadService() {
	vi.resetModules();
	const { WithdrawalService } = await import(
		"@/modules/payment/withdrawal.service"
	);
	return WithdrawalService.getInstance();
}

const auth = { id: 5 } as any;
const balanceRow = { id: 1, instructorId: 5, available: 500000, withdrawn: 0 };

describe("WithdrawalService", () => {
	beforeEach(() => {
		mocks.results.length = 0;
		mocks.records.length = 0;
		mocks.paystackConfig.secret = "sk_test_x";
		mocks.paystackConfig.devResolveFallback = true;
		mocks.paystackConfig.withdrawalsTransferEnabled = true;
		mocks.paystack.resolveBankCode.mockClear();
		mocks.paystack.resolveBankCode.mockResolvedValue("044" as never);
		mocks.paystack.resolveAccountNumber.mockClear();
		mocks.paystack.createRecipient.mockClear();
		mocks.paystack.transfer.mockClear();
		mocks.paystack.listBanks.mockClear();
		mocks.emailAdd.mockClear();
		mocks.notify.mockClear();
	});

	const payoutRow = {
		bankName: "GTBank",
		bankCode: "058",
		accountNumber: "0123456789",
		accountName: "SARAFTA SATAE",
		verifiedAt: null,
	};

	/* @info - The approve email is fire-and-forget, so let its microtasks settle
	 * before asserting on the queue (and before asserting it stayed silent). */
	const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

	it("create: insufficient balance → 400, no rows", async () => {
		mocks.results.push([{ ...payoutRow }], [{ ...balanceRow, available: 100000 }]);
		const service = await loadService();
		await expect(service.create(auth, { amount: 200000 })).rejects.toThrow(
			"Insufficient balance",
		);
		expect(mocks.records).toHaveLength(0);
	});

	it("create: holds balance + writes withdrawal + ledger debit", async () => {
		mocks.results.push([{ ...payoutRow }], [{ ...balanceRow }], [{ id: 7 }]);
		const service = await loadService();
		const w = await service.create(auth, { amount: 100000 });

		expect(w!.id).toBe(7);
		const updates = mocks.records.filter((r) => r.kind === "update");
		expect(updates[0].payload).toEqual({ available: 400000 });
		const inserts = mocks.records.filter((r) => r.kind === "insert");
		expect(inserts[inserts.length - 1].payload).toMatchObject({
			type: "debit",
			category: "withdrawal",
			amount: 100000,
			balanceAfter: 400000,
		});
		expect(String(inserts[inserts.length - 1]!.payload.reference).startsWith("wd-")).toBe(true);
	});

	it("create: without a payout account → 400, nothing held", async () => {
		mocks.results.push([]);
		const service = await loadService();
		await expect(service.create(auth, { amount: 100000 })).rejects.toThrow(
			"Add a payout account before withdrawing.",
		);
		expect(mocks.records).toHaveLength(0);
	});

	it("create: snapshots the stored account and ignores injected bank fields", async () => {
		mocks.results.push([{ ...payoutRow }], [{ ...balanceRow }], [{ id: 7 }]);
		const service = await loadService();
		/* @info - The request body carries no bank fields any more; even if a caller
		 *         injects them they must not reach the row. */
		await service.create(auth, {
			amount: 100000,
			bankName: "Attacker Bank",
			accountName: "Attacker Name",
			accountNumber: "9999999999",
		} as any);

		const withdrawalInsert = mocks.records.find(
			(r) => r.kind === "insert" && r.payload.status === "pending",
		);
		expect(withdrawalInsert!.payload).toMatchObject({
			bankName: "GTBank",
			bankCode: "058",
			accountNumber: "0123456789",
			accountName: "SARAFTA SATAE",
		});
	});

	it("approve: snapshot bank code wins over name resolution", async () => {
		mocks.paystackConfig.secret = "sk_live_x";
		mocks.results.push(
			[{ id: 7, instructorId: 5, amount: 100000, bankName: "GTBank", bankCode: "058", accountNumber: "0123456789", accountName: "Sarafa", status: "pending", reference: "wd-1" }],
			[{ ...balanceRow }],
		);
		const service = await loadService();
		const res = await service.approve(7);

		expect(res.status).toBe("completed");
		expect(mocks.paystack.resolveBankCode).not.toHaveBeenCalled();
		expect(mocks.paystack.createRecipient).toHaveBeenCalledWith({
			bankCode: "058",
			accountNumber: "0123456789",
			accountName: "Sarafa",
		});
	});

	it("approve: legacy row without a bank code still resolves by name", async () => {
		mocks.paystackConfig.secret = "sk_live_x";
		mocks.results.push(
			[{ id: 7, instructorId: 5, amount: 100000, bankName: "Access Bank", accountNumber: "0123456789", accountName: "Sarafa", status: "pending", reference: "wd-1" }],
			[{ ...balanceRow }],
		);
		const service = await loadService();
		await service.approve(7);
		expect(mocks.paystack.resolveBankCode).toHaveBeenCalledWith("Access Bank");
	});

	it("approve: transfers with the withdrawal reference + marks completed", async () => {
		mocks.results.push(
			[{ id: 7, instructorId: 5, amount: 100000, bankName: "Access Bank", accountNumber: "0123456789", accountName: "Sarafa", status: "pending", reference: "wd-1" }],
			[{ ...balanceRow }],
		);
		const service = await loadService();
		const res = await service.approve(7);

		expect(res.status).toBe("completed");
		expect(mocks.paystack.createRecipient).toHaveBeenCalledWith({
			bankCode: "001",
			accountNumber: "0123456789",
			accountName: "Sarafa",
		});
		expect(mocks.paystack.transfer).toHaveBeenCalledWith({
			recipientCode: "RCP_test",
			amount: 100000,
			reference: "wd-1",
		});
		const withdrawnUpdate = mocks.records.find(
			(r) => r.kind === "update" && r.payload.withdrawn === 100000,
		);
		expect(withdrawnUpdate).toBeDefined();
	});

	it("approve on already-processed → conflict", async () => {
		mocks.results.push([
			{ id: 7, instructorId: 5, amount: 100000, status: "completed", reference: "wd-1" },
		]);
		const service = await loadService();
		await expect(service.approve(7)).rejects.toThrow("no longer pending");
		expect(mocks.paystack.transfer).not.toHaveBeenCalled();
	});

	it("reject: releases the hold back into available", async () => {
		mocks.results.push(
			[{ id: 7, instructorId: 5, amount: 100000, status: "pending", reference: "wd-1" }],
			[{ ...balanceRow, available: 400000 }],
		);
		const service = await loadService();
		const res = await service.reject(7);

		expect(res.status).toBe("rejected");
		const last = mocks.records[mocks.records.length - 1];
		expect(last.kind).toBe("insert");
		expect(last.payload).toMatchObject({
			type: "credit",
			category: "withdrawal_refund",
			amount: 100000,
			balanceAfter: 500000,
			reference: "wd-1",
		});
	});

	it("transfer failure → failed + refund", async () => {
		mocks.paystack.transfer.mockRejectedValueOnce(new Error("bank down"));
		mocks.results.push(
			[{ id: 7, instructorId: 5, amount: 100000, status: "pending", reference: "wd-1" }],
			[{ ...balanceRow, available: 400000 }],
		);
		const service = await loadService();
		const res = await service.approve(7);
		expect(res.status).toBe("failed");

		const last = mocks.records[mocks.records.length - 1];
		expect(last.kind).toBe("insert");
		expect(last.payload.category).toBe("withdrawal_refund");
		expect(last.payload.balanceAfter).toBe(500000);
	});


	it("verifyAccount: resolves with test-mode bank code 001", async () => {
		mocks.paystack.resolveAccountNumber.mockResolvedValueOnce({
			accountNumber: "0123456789",
			accountName: "TEST ACCOUNT 0123456789",
		});
		const service = await loadService();
		const r = await service.verifyAccount(auth, {
			bankName: "GTBank",
			accountNumber: "0123456789",
		});
		expect(r).toEqual({
			bankName: "GTBank",
			bankCode: "001",
			accountNumber: "0123456789",
			accountName: "TEST ACCOUNT 0123456789",
			simulated: true,
		});
	});

	it("verifyAccount: unresolved + dev fallback returns a test account", async () => {
		mocks.paystack.resolveAccountNumber.mockResolvedValueOnce(null as any);
		const service = await loadService();
		const r = await service.verifyAccount(auth, {
			bankName: "GTBank",
			accountNumber: "0123456789",
		});
		expect(r.accountName).toBe("Test Account"); // dev fallback enabled
		expect(r.simulated).toBe(true);
	});

	it("verifyAccount: bankCode goes straight to Paystack (no name lookup)", async () => {
		const service = await loadService();
		const r = await service.verifyAccount(auth, {
			bankCode: "058",
			accountNumber: "0123456789",
		});

		expect(mocks.paystack.resolveAccountNumber).toHaveBeenCalledWith(
			"0123456789",
			"058",
		);
		expect(mocks.paystack.resolveBankCode).not.toHaveBeenCalled();
		expect(r).toMatchObject({
			bankCode: "058",
			accountNumber: "0123456789",
			accountName: "SARAFTA SATAE",
			simulated: true,
		});
	});

	it("verifyAccount: live keys report simulated=false", async () => {
		mocks.paystackConfig.secret = "sk_live_x";
		const service = await loadService();
		const r = await service.verifyAccount(auth, {
			bankCode: "058",
			accountNumber: "0123456789",
		});
		expect(r.simulated).toBe(false);
	});

	it("verifyAccount: missing bank → 400 (no Paystack call)", async () => {
		const service = await loadService();
		await expect(
			service.verifyAccount(auth, { accountNumber: "0123456789" }),
		).rejects.toThrow("Select a bank");
		expect(mocks.paystack.resolveAccountNumber).not.toHaveBeenCalled();
	});

	it("approve (kill switch off): no Paystack call, row → processing + note", async () => {
		mocks.paystackConfig.withdrawalsTransferEnabled = false;
		mocks.results.push(
			[{ id: 7, instructorId: 5, amount: 100000, bankName: "Access Bank", accountNumber: "0123456789", accountName: "Sarafa", status: "pending", reference: "wd-1" }],
			[{ ...balanceRow }],
		);
		const service = await loadService();
		const res = await service.approve(7);

		expect(res).toEqual({ status: "processing", transferSuppressed: true });
		expect(mocks.paystack.createRecipient).not.toHaveBeenCalled();
		expect(mocks.paystack.transfer).not.toHaveBeenCalled();
		const statusUpdate = mocks.records.find(
			(r) => r.kind === "update" && r.payload.status === "processing",
		);
		expect(statusUpdate?.payload).toMatchObject({
			note: "transfer suppressed (non-prod)",
		});
		/* @info - Identical bookkeeping to prod, note apart. */
		const withdrawnUpdate = mocks.records.find(
			(r) => r.kind === "update" && r.payload.withdrawn === 100000,
		);
		expect(withdrawnUpdate).toBeDefined();
	});

	it("approve (kill switch off): second approve conflicts like prod", async () => {
		mocks.paystackConfig.withdrawalsTransferEnabled = false;
		mocks.results.push([
			{ id: 7, instructorId: 5, amount: 100000, status: "processing", reference: "wd-1" },
		]);
		const service = await loadService();
		await expect(service.approve(7)).rejects.toThrow("no longer pending");
		expect(mocks.paystack.createRecipient).not.toHaveBeenCalled();
		expect(mocks.paystack.transfer).not.toHaveBeenCalled();
	});

	it("approve: emails the instructor that the payout is on its way", async () => {
		mocks.results.push(
			[{ id: 7, instructorId: 5, amount: 100000, bankName: "Access Bank", accountNumber: "0123456789", accountName: "Sarafa", status: "pending", reference: "wd-1" }],
			[{ ...balanceRow }],
			[{ firstName: "Sarafa", email: "sarafa@example.com" }],
		);
		const service = await loadService();
		await service.approve(7);
		await flush();

		expect(mocks.emailAdd).toHaveBeenCalledTimes(1);
		const [jobName, data] = mocks.emailAdd.mock.calls[0] as any;
		expect(jobName).toBe("withdrawal-processed");
		expect(data.template).toBe("withdrawal-processed");
		expect(data.message.to).toBe("sarafa@example.com");
		expect(data.message.subject).toBe(
			"Your ₦1,000 withdrawal is on its way",
		);
		expect(data.locals).toMatchObject({
			instructorName: "Sarafa",
			amount: "1,000",
			bankName: "Access Bank",
			accountLast4: "6789",
			reference: "wd-1",
		});
		expect(data.locals.processedAt).toMatch(/^\d{1,2} \w+ \d{4}$/);
		expect(data.locals.dashboardUrl).toContain("/dashboard/earnings");
		expect(data.idempotencyKey).toBe("withdrawal-processed:7");
		/* @info - Only the last 4 digits of the account travel in an email. */
		expect(JSON.stringify(data)).not.toContain("0123456789");
	});

	it("approve (kill switch off): still emails the instructor", async () => {
		mocks.paystackConfig.withdrawalsTransferEnabled = false;
		mocks.results.push(
			[{ id: 7, instructorId: 5, amount: 100000, bankName: "Access Bank", accountNumber: "0123456789", accountName: "Sarafa", status: "pending", reference: "wd-1" }],
			[{ ...balanceRow }],
			[{ firstName: "Sarafa", email: "sarafa@example.com" }],
		);
		const service = await loadService();
		const res = await service.approve(7);
		await flush();

		expect(res).toEqual({ status: "processing", transferSuppressed: true });
		expect(mocks.emailAdd).toHaveBeenCalledTimes(1);
	});

	it("approve: instructor without an email on file still approves, no email sent", async () => {
		mocks.results.push(
			[{ id: 7, instructorId: 5, amount: 100000, bankName: "Access Bank", accountNumber: "0123456789", accountName: "Sarafa", status: "pending", reference: "wd-1" }],
			[{ ...balanceRow }],
			[],
		);
		const service = await loadService();
		const res = await service.approve(7);
		await flush();

		expect(res.status).toBe("completed");
		expect(mocks.emailAdd).not.toHaveBeenCalled();
	});

	it("approve: a failed transfer sends no email", async () => {
		mocks.paystack.transfer.mockRejectedValueOnce(new Error("bank down"));
		mocks.results.push(
			[{ id: 7, instructorId: 5, amount: 100000, bankName: "Access Bank", accountNumber: "0123456789", accountName: "Sarafa", status: "pending", reference: "wd-1" }],
			[{ ...balanceRow, available: 400000 }],
		);
		const service = await loadService();
		const res = await service.approve(7);
		await flush();

		expect(res.status).toBe("failed");
		expect(mocks.emailAdd).not.toHaveBeenCalled();
	});

	it("reject: sends no processed email", async () => {
		mocks.results.push(
			[{ id: 7, instructorId: 5, amount: 100000, status: "pending", reference: "wd-1" }],
			[{ ...balanceRow, available: 400000 }],
		);
		const service = await loadService();
		await service.reject(7);
		await flush();
		expect(mocks.emailAdd).not.toHaveBeenCalled();
	});

	it("approve: unresolvable bank fails the row instead of guessing a code", async () => {
		mocks.paystackConfig.secret = "sk_live_x";
		mocks.paystack.resolveBankCode.mockResolvedValueOnce(null as never);
		mocks.results.push(
			[{ id: 7, instructorId: 5, amount: 100000, bankName: "Ambiguous Bank", accountNumber: "0123456789", accountName: "Sarafa", status: "pending", reference: "wd-1" }],
			[{ ...balanceRow, available: 400000 }],
		);
		const service = await loadService();
		const res = await service.approve(7);

		expect(res.status).toBe("failed");
		expect(String(res.transferError)).toContain("Could not resolve the bank");
		expect(mocks.paystack.createRecipient).not.toHaveBeenCalled();
		const last = mocks.records[mocks.records.length - 1];
		expect(last.payload.category).toBe("withdrawal_refund");
	});

	it("listBanks: delegates to the cached upstream list", async () => {
		const service = await loadService();
		const banks = await service.listBanks();
		expect(banks).toEqual([{ name: "GTBank", code: "058" }]);
		expect(mocks.paystack.listBanks).toHaveBeenCalled();
	});

	it("listAdmin: returns queued withdrawals", async () => {
		mocks.results.push([{ id: 7, firstName: "Sarafa", status: "pending" }]);
		const service = await loadService();
		const list = await service.listAdmin({ status: "pending" });
		expect(list.items).toHaveLength(1);
		expect(list.items[0]!.firstName).toBe("Sarafa");
	});

	it("listAdmin: reports the platform's Paystack cost + suppression note per row", async () => {
		mocks.results.push([
			{ id: 8, amount: 5_000_000, status: "completed", note: null },
			{
				id: 9,
				amount: 200_000,
				status: "processing",
				note: "transfer suppressed (non-prod)",
			},
		]);
		const service = await loadService();
		const list = await service.listAdmin();

		expect(list.items[0]!.paystackCost).toEqual({
			fee: 2_500,
			stampDuty: 5_000,
			total: 7_500,
		});
		expect(list.items[1]!.paystackCost).toEqual({
			fee: 1_000,
			stampDuty: 0,
			total: 1_000,
		});
		expect(list.items[1]!.note).toBe("transfer suppressed (non-prod)");
	});

	it("paystackTransferCost: fee tiers + ₦50 stamp duty at ₦10,000", async () => {
		const { paystackTransferCost } = await import(
			"@/modules/payment/withdrawal.service"
		);

		/* ₦4,999 */ expect(paystackTransferCost(499_900)).toEqual({
			fee: 1_000,
			stampDuty: 0,
			total: 1_000,
		});
		/* ₦5,000 */ expect(paystackTransferCost(500_000)).toEqual({
			fee: 1_000,
			stampDuty: 0,
			total: 1_000,
		});
		/* ₦5,001 */ expect(paystackTransferCost(500_100)).toEqual({
			fee: 2_500,
			stampDuty: 0,
			total: 2_500,
		});
		/* ₦9,999 */ expect(paystackTransferCost(999_900)).toEqual({
			fee: 2_500,
			stampDuty: 0,
			total: 2_500,
		});
		/* ₦10,000 */ expect(paystackTransferCost(1_000_000)).toEqual({
			fee: 2_500,
			stampDuty: 5_000,
			total: 7_500,
		});
		/* ₦50,001 */ expect(paystackTransferCost(5_000_100)).toEqual({
			fee: 5_000,
			stampDuty: 5_000,
			total: 10_000,
		});
	});

	it("savePayoutAccount: resolves server-side and stores the Paystack name", async () => {
		const service = await loadService();
		const saved = await service.savePayoutAccount(auth, {
			bankCode: "058",
			accountNumber: "0123456789",
		});

		expect(mocks.paystack.resolveAccountNumber).toHaveBeenCalledWith(
			"0123456789",
			"058",
		);
		expect(saved).toMatchObject({
			bankName: "GTBank",
			bankCode: "058",
			accountNumber: "0123456789",
			accountName: "SARAFTA SATAE",
			simulated: true,
		});
		const update = mocks.records.find((r) => r.kind === "update");
		expect(update!.payload).toMatchObject({
			payoutBankName: "GTBank",
			payoutBankCode: "058",
			payoutAccountNumber: "0123456789",
			payoutAccountName: "SARAFTA SATAE",
		});
	});

	it("savePayoutAccount: unknown bank code → 400, nothing resolved or stored", async () => {
		const service = await loadService();
		await expect(
			service.savePayoutAccount(auth, {
				bankCode: "999",
				accountNumber: "0123456789",
			}),
		).rejects.toThrow("Unknown bank");
		expect(mocks.paystack.resolveAccountNumber).not.toHaveBeenCalled();
		expect(mocks.records).toHaveLength(0);
	});

	it("savePayoutAccount: resolve failure without the dev fallback → 400, nothing stored", async () => {
		mocks.paystackConfig.devResolveFallback = false;
		mocks.paystack.resolveAccountNumber.mockResolvedValueOnce(null as any);
		const service = await loadService();
		await expect(
			service.savePayoutAccount(auth, {
				bankCode: "058",
				accountNumber: "0123456789",
			}),
		).rejects.toThrow("Could not verify this account");
		expect(mocks.records).toHaveLength(0);
	});

	it("deletePayoutAccount: clears every payout field", async () => {
		const service = await loadService();
		await service.deletePayoutAccount(auth);

		const update = mocks.records.find((r) => r.kind === "update");
		expect(update!.payload).toEqual({
			payoutBankName: null,
			payoutBankCode: null,
			payoutAccountNumber: null,
			payoutAccountName: null,
			payoutAccountVerifiedAt: null,
		});
	});

	it("payoutAccount: a partial row reads as absent", async () => {
		mocks.results.push([
			{
				bankName: "GTBank",
				bankCode: null,
				accountNumber: null,
				accountName: null,
				verifiedAt: null,
			},
		]);
		const service = await loadService();
		expect(await service.payoutAccount(auth)).toBeNull();
	});
});
