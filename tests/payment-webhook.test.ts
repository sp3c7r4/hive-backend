import crypto from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { config } from "@/config";

/* Mocks — hoisted per project pattern. PaystackService.handleChargeSuccess uses
 * getDb() + withTransaction; both mocked so the ledger math is deterministic. */
const mocks = vi.hoisted(() => {
	const results: any[] = [];
	const records: any[] = [];

	const thenable = {
		then: async (resolve: any) => resolve(results.shift() ?? []),
	};

	const chain: any = {
		select: () => chain,
		from: () => chain,
		where: () => chain,
		orderBy: () => chain,
		for: () => chain,
		groupBy: () => chain,
		limit: () => thenable,
		then: async (resolve: any) => resolve(results.shift() ?? []),
	};

	const tx = {
		select: () => chain,
		update: () => ({
			set: (payload: any) => ({
				where: () => {
					records.push({ kind: "update", payload });
					return thenable;
				},
			}),
		}),
		insert: () => ({
			values: (payload: any) => {
				records.push({ kind: "insert", payload });
				return Object.assign(thenable, { returning: () => thenable });
			},
		}),
		delete: () => ({ where: () => thenable }),
	};

	return { db: chain, tx, results, records };
});

vi.mock("@/db/postgres.db", () => ({ getDb: () => mocks.db }));
vi.mock("@/helpers/db.helper", () => ({
	withTransaction: (fn: any) => fn(mocks.tx),
}));
vi.mock("@/services/queues/email.queue.service", () => ({
	EmailQueueService: {
		getInstance: () => ({
			add: () => Promise.resolve({ id: "job-1" }),
		}),
	},
}));

async function loadService() {
	vi.resetModules();
	const { PaystackService } = await import(
		"@/modules/payment/services/paystack.service"
	);
	return PaystackService.getInstance();
}

const sign = (body: any) =>
	crypto
		.createHmac("sha512", config.paystack.secret)
		.update(JSON.stringify(body))
		.digest("hex");

const pendingPayment = {
	id: 99,
	reference: "hive-abc",
	status: "pending",
	amount: 10000,
	platformFee: 1000,
	courseId: 9,
	communityId: null,
	enrollmentId: null,
	receiptUrl: null,
};

describe("PaystackService.handleChargeSuccess (M1 ledger)", () => {
	beforeEach(() => {
		mocks.results.length = 0;
		mocks.records.length = 0;
	});

	it("duplicate webhook: bails without touching the ledger", async () => {
		mocks.results.push([{ ...pendingPayment, status: "success" }]);
		const service = await loadService();
		const body = { event: "charge.success", data: { reference: "hive-abc" } };
		const ok = await service.handleWebhook({
			paystack_signature: sign(body),
			body,
		} as any);

		expect(ok).toBe(true);
		expect(mocks.records).toHaveLength(0);
	});

	it("credits the course instructor: net = amount - platformFee, balanceAfter correct", async () => {
		mocks.results.push(
			[{ ...pendingPayment }], // payment lookup
			[{ instructorId: 5 }], // course → instructor
			[{ ...pendingPayment }], // re-check inside tx
			{ ok: true }, // update payments (awaited before balance select)
			[], // balance select: no row → insert path
			{ ok: true }, // insert balance
			{ ok: true }, // insert transaction
			[], // enrollment dedup: none
			[{ id: 1 }], // insert enrollment returning
			{ ok: true }, // update payment enrollmentId
			[{ email: "stu@t.com", firstName: "Stu" }], // users (email)
			[{ title: "Course" }], // course title (email)
		);

		const service = await loadService();
		const body = {
			event: "charge.success",
			data: { reference: "hive-abc", receipt_url: "https://paystack.com/r" },
		};
		const ok = await service.handleWebhook({
			paystack_signature: sign(body),
			body,
		} as any);

		expect(ok).toBe(true);
		const updatePayment = mocks.records.find(
			(r) => r.kind === "update" && r.payload.status === "success",
		);
		expect(updatePayment).toBeDefined();
		expect(updatePayment!.payload.receiptUrl).toBe("https://paystack.com/r");

		const insertTx = mocks.records.find(
			(r) => r.kind === "insert" && (r.payload as any).instructorId === 5 && (r.payload as any).type === "credit",
		);
		expect(insertTx).toBeDefined();
		expect(insertTx!.payload).toMatchObject({
			instructorId: 5,
			type: "credit",
			category: "enrollment",
			amount: 9000,
			balanceAfter: 9000,
			reference: "hive-abc",
			paymentId: 99,
		});
	});

	it("unresolvable payee: payment marked success, no credit", async () => {
		mocks.results.push(
			[{ ...pendingPayment }],
			[],
			[{ ...pendingPayment }],
			{ ok: true },
		);
		const service = await loadService();
		const body = { event: "charge.success", data: { reference: "hive-abc" } };
		await service.handleWebhook({
			paystack_signature: sign(body),
			body,
		} as any);

		const updates = mocks.records.filter((r) => r.kind === "update");
		const inserts = mocks.records.filter((r) => r.kind === "insert");
		expect(updates.length).toBe(1); // payment only
		expect(inserts.length).toBe(0);
	});

	it("community sale credits the community owner", async () => {
		mocks.results.push(
			[{ ...pendingPayment, courseId: null, communityId: 9 }],
			[{ ownerId: 8 }],
			[{ ...pendingPayment, courseId: null, communityId: 9 }],
			{ ok: true },
			[],
			{ ok: true },
			{ ok: true },
			[], // membership dedup: none
			[{ email: "stu@t.com", firstName: "Stu" }], // users (email)
			[{ name: "Comm" }], // community name (email)
		);
		const service = await loadService();
		const body = { event: "charge.success", data: { reference: "hive-abc" } };
		await service.handleWebhook({
			paystack_signature: sign(body),
			body,
		} as any);

		const ledger = mocks.records.find(
			(r) => r.kind === "insert" && (r.payload as any).instructorId === 8 && (r.payload as any).type === "credit",
		);
		expect(ledger).toBeDefined();
		expect(ledger!.payload).toMatchObject({
			instructorId: 8,
			category: "community",
			amount: 9000,
		});
	});
});
