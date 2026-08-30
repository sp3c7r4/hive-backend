import { describe, it, expect, vi, beforeEach } from "vitest";

/* Mocks — same shape as payment-webhook.test.ts, extended with .returning()
 * (enrollment insert) and a mocked email queue. */
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

	return { db: chain, tx, results, records, emailAdds: [] as any[] };
});

vi.mock("@/db/postgres.db", () => ({ getDb: () => mocks.db }));
vi.mock("@/helpers/db.helper", () => ({
	withTransaction: (fn: any) => fn(mocks.tx),
}));
vi.mock("@/services/queues/email.queue.service", () => ({
	EmailQueueService: {
		getInstance: () => ({
			add: (name: string, payload: any) => {
				mocks.emailAdds.push({ name, payload });
				return Promise.resolve({ id: "job-1" });
			},
		}),
	},
}));

async function loadService() {
	vi.resetModules();
	const { PaymentSettlementService } = await import(
		"@/modules/payment/services/payment-settlement.service"
	);
	return PaymentSettlementService.getInstance();
}

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
	payerId: 7,
};

describe("PaymentSettlementService", () => {
	beforeEach(() => {
		mocks.results.length = 0;
		mocks.records.length = 0;
		mocks.emailAdds.length = 0;
	});

	it("settles a course sale: success + ledger + ENROLLMENT + email (idempotent on rerun)", async () => {
		mocks.results.push(
			[{ ...pendingPayment }], // 1 payment lookup
			[{ instructorId: 5 }], // 2 course → instructor
			[{ ...pendingPayment }], // 3 re-check inside tx
			{ ok: true }, // 4 update payments → success
			[], // 5 balance select: no row
			{ ok: true }, // 6 insert balance
			{ ok: true }, // 7 insert transaction
			[], // 8 enrollment dedup select: none
			[{ id: 55 }], // 9 insert enrollment returning id
			{ ok: true }, // 10 update payment enrollmentId
			[{ email: "student@test.com", firstName: "Test" }], // 11 users for email
			[{ title: "Intro To TS" }], // 12 course title
		);

		const service = await loadService();
		const ok = await service.settlePayment({ reference: "hive-abc", receiptUrl: "https://paystack.com/r" });

		expect(ok).toBe(true);
		expect(
			mocks.records.find((r) => r.kind === "update" && r.payload.status === "success"),
		).toBeDefined();
		expect(mocks.records[mocks.records.length - 1].payload).toMatchObject({
			enrollmentId: 55,
		});
		const enrollInsert = mocks.records.find(
			(r) => r.kind === "insert" && (r.payload as any).courseId === 9,
		);
		expect(enrollInsert).toBeDefined();
		expect(enrollInsert!.payload).toMatchObject({ userId: 7, courseId: 9 });
		expect(mocks.emailAdds).toHaveLength(1);
		expect(mocks.emailAdds[0].payload.message.to).toBe("student@test.com");

		/* Rerun (duplicate webhook): payment already success → no new rows */
		mocks.results.length = 0;
		mocks.records.length = 0;
		mocks.results.push([{ ...pendingPayment, status: "success" }]);
		const again = await service.settlePayment({ reference: "hive-abc" });
		expect(again).toBe(true);
		expect(mocks.records).toHaveLength(0);
	});

	it("does not double-enroll when an enrollment already exists", async () => {
		mocks.results.push(
			[{ ...pendingPayment }],
			[{ instructorId: 5 }],
			[{ ...pendingPayment }],
			{ ok: true },
			[{ available: 5000 }], // balance exists → update path
			{ ok: true }, // update balance
			{ ok: true }, // insert transaction
			[{ id: 55 }], // enrollment dedup: EXISTS
			[{ email: "student@test.com", firstName: "Test" }],
			[{ title: "Intro To TS" }],
		);

		const service = await loadService();
		const ok = await service.settlePayment({ reference: "hive-abc" });
		expect(ok).toBe(true);
		const enrollInserts = mocks.records.filter(
			(r) => r.kind === "insert" && (r.payload as any).courseId === 9,
		);
		expect(enrollInserts).toHaveLength(0);
	});

	it("settles a community sale into a membership", async () => {
		mocks.results.push(
			[{ ...pendingPayment, courseId: null, communityId: 3 }],
			[{ ownerId: 5 }],
			[{ ...pendingPayment, courseId: null, communityId: 3 }],
			{ ok: true },
			[{ available: 0 }],
			{ ok: true },
			{ ok: true },
			[], // membership dedup: none
			[{ email: "student@test.com", firstName: "Test" }],
			[{ name: "Ai Engineering" }],
		);

		const service = await loadService();
		const ok = await service.settlePayment({ reference: "hive-abc" });
		expect(ok).toBe(true);
		const memberInsert = mocks.records.find(
			(r) => r.kind === "insert" && (r.payload as any).communityId === 3,
		);
		expect(memberInsert).toBeDefined();
		expect(memberInsert!.payload).toMatchObject({
			communityId: 3,
			userId: 7,
			role: "student",
			status: "active",
		});
	});

	it("unknown reference: logs and returns true (stop retries)", async () => {
		mocks.results.push([]); // payment lookup: nothing
		const service = await loadService();
		const ok = await service.settlePayment({ reference: "hive-unknown" });
		expect(ok).toBe(true);
		expect(mocks.records).toHaveLength(0);
	});
});
