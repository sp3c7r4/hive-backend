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
	};

	return { db: chain, tx, paystack, results, records };
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
		mocks.paystack.resolveBankCode.mockClear();
		mocks.paystack.resolveAccountNumber.mockClear();
		mocks.paystack.createRecipient.mockClear();
		mocks.paystack.transfer.mockClear();
	});

	it("create: insufficient balance → 400, no rows", async () => {
		mocks.results.push([{ ...balanceRow, available: 100000 }]);
		const service = await loadService();
		await expect(
			service.create(auth, {
				amount: 200000,
				bankName: "Access Bank",
				accountNumber: "0123456789",
				accountName: "Sarafa Satae",
			}),
		).rejects.toThrow("Insufficient balance");
		expect(mocks.records).toHaveLength(0);
	});

	it("create: holds balance + writes withdrawal + ledger debit", async () => {
		mocks.results.push([{ ...balanceRow }], [{ id: 7 }]);
		const service = await loadService();
		const w = await service.create(auth, {
			amount: 100000,
			bankName: "Access Bank",
			accountNumber: "0123456789",
			accountName: "Sarafa Satae",
		});

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

	it("approve: transfers with the withdrawal reference + marks completed", async () => {
		mocks.results.push(
			[{ id: 7, instructorId: 5, amount: 100000, bankName: "Access Bank", accountNumber: "0123456789", accountName: "Sarafa", status: "pending", reference: "wd-1" }],
			[{ ...balanceRow }],
		);
		const service = await loadService();
		const res = await service.approve(7);

		expect(res.status).toBe("completed");
		expect(mocks.paystack.createRecipient).toHaveBeenCalledWith({
			bankCode: "044",
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


	it("verifyAccount: returns the bank-owned account name", async () => {
		mocks.paystack.resolveBankCode.mockResolvedValueOnce("058");
		mocks.paystack.resolveAccountNumber.mockResolvedValueOnce({
			accountNumber: "0123456789",
			accountName: "SARAFTA SATAE",
		});
		const service = await loadService();
		const r = await service.verifyAccount(auth, {
			bankName: "GTBank",
			accountNumber: "0123456789",
		});
		expect(r).toEqual({
			bankName: "GTBank",
			bankCode: "058",
			accountNumber: "0123456789",
			accountName: "SARAFTA SATAE",
		});
	});

	it("verifyAccount: unresolved + dev fallback returns a test account", async () => {
		mocks.paystack.resolveBankCode.mockResolvedValueOnce("058");
		mocks.paystack.resolveAccountNumber.mockResolvedValueOnce(null as any);
		const service = await loadService();
		const r = await service.verifyAccount(auth, {
			bankName: "GTBank",
			accountNumber: "0123456789",
		});
		expect(r.accountName).toBe("Test Account"); // dev fallback enabled
	});

	it("listAdmin: returns queued withdrawals", async () => {
		mocks.results.push([{ id: 7, firstName: "Sarafa", status: "pending" }]);
		const service = await loadService();
		const list = await service.listAdmin({ status: "pending" });
		expect(list.items).toHaveLength(1);
		expect(list.items[0]!.firstName).toBe("Sarafa");
	});
});
