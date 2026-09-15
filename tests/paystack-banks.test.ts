import { beforeEach, describe, expect, it, vi } from "vitest";

/* PaystackService bank list + name→code matching. The upstream axios call and
 * Redis are both faked so caching, the last-good fallback, and the exact-match
 * rule are deterministic without a network or a Redis server. */
const mocks = vi.hoisted(() => {
	const store = new Map<string, string>();
	const setCalls: { key: string; ttl?: number }[] = [];
	const apiGet = vi.fn();
	return { store, setCalls, apiGet };
});

vi.mock("@/services/api.service", () => ({
	ApiService: class {
		get = mocks.apiGet;
		post = vi.fn();
	},
}));

vi.mock("@/services/cache.service", () => ({
	CacheService: {
		getInstance: () => ({
			get: async (key: string) =>
				mocks.store.has(key) ? JSON.parse(mocks.store.get(key)!) : null,
			set: async (key: string, value: unknown, ttl?: number) => {
				mocks.setCalls.push({ key, ttl });
				mocks.store.set(key, JSON.stringify(value));
			},
			getRedisClient: () => ({
				get: async (key: string) => mocks.store.get(key) ?? null,
				set: async (key: string, value: string) => {
					mocks.setCalls.push({ key });
					mocks.store.set(key, value);
				},
			}),
		}),
	},
}));

/* Swept in by PaymentSettlementService, which PaystackService instantiates. */
vi.mock("@/services/queues/email.queue.service", () => ({
	EmailQueueService: {
		getInstance: () => ({ add: () => Promise.resolve({ id: "job-1" }) }),
	},
}));

const BANKS_KEY = "payments:paystack:banks:ngn";
const LAST_GOOD_KEY = "payments:paystack:banks:ngn:last-good";

async function loadService() {
	vi.resetModules();
	const { PaystackService } = await import(
		"@/modules/payment/services/paystack.service"
	);
	return PaystackService.getInstance();
}

const upstream = (banks: { name: string; code: string }[]) => ({
	data: { data: banks },
});

describe("PaystackService banks", () => {
	beforeEach(() => {
		mocks.store.clear();
		mocks.setCalls.length = 0;
		mocks.apiGet.mockReset();
	});

	it("listBanks: dedupes by code, drops nameless rows, sorts by name", async () => {
		mocks.apiGet.mockResolvedValueOnce(
			upstream([
				{ name: "Zenith Bank", code: "057" },
				{ name: "GTBank", code: "058" },
				{ name: "GTBank (duplicate listing)", code: "058" },
				{ name: "", code: "999" },
			]),
		);
		const service = await loadService();

		const banks = await service.listBanks();

		expect(banks.map((b) => b.name)).toEqual(["GTBank", "Zenith Bank"]);
		expect(banks.map((b) => b.code)).toEqual(["058", "057"]);
	});

	it("listBanks: caches 24h and writes a non-expiring last-good copy", async () => {
		mocks.apiGet.mockResolvedValueOnce(
			upstream([{ name: "GTBank", code: "058" }]),
		);
		const service = await loadService();

		await service.listBanks();

		const ttlCall = mocks.setCalls.find((c) => c.key === BANKS_KEY);
		expect(ttlCall?.ttl).toBe(86_400);
		const lastGood = mocks.setCalls.find((c) => c.key === LAST_GOOD_KEY);
		expect(lastGood).toBeDefined();
		expect(lastGood?.ttl).toBeUndefined();
	});

	it("listBanks: a warm cache skips the upstream call", async () => {
		mocks.apiGet.mockResolvedValueOnce(
			upstream([{ name: "GTBank", code: "058" }]),
		);
		const service = await loadService();
		await service.listBanks();

		const banks = await service.listBanks();

		expect(banks).toEqual([{ name: "GTBank", code: "058" }]);
		expect(mocks.apiGet).toHaveBeenCalledTimes(1);
	});

	it("listBanks: an upstream outage serves the last-good list", async () => {
		mocks.store.set(
			LAST_GOOD_KEY,
			JSON.stringify([{ name: "GTBank", code: "058" }]),
		);
		mocks.apiGet.mockRejectedValueOnce(new Error("ECONNRESET"));
		const service = await loadService();

		const banks = await service.listBanks();

		expect(banks).toEqual([{ name: "GTBank", code: "058" }]);
	});

	it("listBanks: a cold cache during an outage returns [] instead of throwing", async () => {
		mocks.apiGet.mockRejectedValueOnce(new Error("ECONNRESET"));
		const service = await loadService();

		await expect(service.listBanks()).resolves.toEqual([]);
	});

	it("resolveBankCode: an exact name wins over a longer name containing it", async () => {
		mocks.apiGet.mockResolvedValueOnce(
			upstream([
				{ name: "Access Bank (Diamond)", code: "063" },
				{ name: "Access Bank", code: "044" },
			]),
		);
		const service = await loadService();

		expect(await service.resolveBankCode("Access Bank")).toBe("044");
	});

	it("resolveBankCode: a unique partial name still resolves (legacy rows)", async () => {
		mocks.apiGet.mockResolvedValueOnce(
			upstream([
				{ name: "Access Bank", code: "044" },
				{ name: "Zenith Bank", code: "057" },
			]),
		);
		const service = await loadService();

		expect(await service.resolveBankCode("zenith")).toBe("057");
	});

	it("resolveBankCode: an ambiguous partial name resolves to null", async () => {
		mocks.apiGet.mockResolvedValueOnce(
			upstream([
				{ name: "Access Bank", code: "044" },
				{ name: "Zenith Bank", code: "057" },
			]),
		);
		const service = await loadService();

		expect(await service.resolveBankCode("Bank")).toBeNull();
	});
});
