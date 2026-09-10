import { Hono } from "hono";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * @info - Wire contract for the messaging lifecycle endpoints: the query flag,
 * its validation, and the unhide route. The real service is mocked so the route
 * + controller + zod layer is what's under test (the service's own behaviour is
 * covered against the database in messaging-lifecycle.test.ts). Session reads go
 * through a fake cache — see role-guards.test.ts for the same technique.
 */
const { mockCalls } = vi.hoisted(() => ({
	mockCalls: {
		list: [] as any[],
		unhide: [] as any[],
	},
}));

const SESSION = {
	authId: "auth:msg-contract",
	userType: "student",
	id: 42,
	email: "msg-contract@test.local",
	firstName: "Msg",
	lastName: "Contract",
	isAuthenticated: true,
	emailVerified: true,
};

vi.mock("@/services/cache.service", () => {
	class FakeCache {
		private static instance: FakeCache;
		readonly redis = {
			get: async () => null,
			set: async () => {},
			del: async () => {},
		};
		static getInstance(): FakeCache {
			if (!FakeCache.instance) FakeCache.instance = new FakeCache();
			return FakeCache.instance;
		}
		get = async <T>(key: string): Promise<T | null> =>
			key === SESSION.authId ? (SESSION as unknown as T) : null;
		set = async (): Promise<void> => {};
		delete = async (): Promise<void> => {};
		getRedisClient() {
			return this.redis;
		}
	}
	return { CacheService: FakeCache };
});

const fakeService = {
	list: async (_authData: any, options?: { includeHidden?: boolean }) => {
		mockCalls.list.push(options);
		return [
			{
				id: 7,
				type: "group",
				title: "Test",
				hidden: options?.includeHidden ?? false,
			},
		];
	},
	unhideConversation: async (authData: any, conversationId: number) => {
		mockCalls.unhide.push({ authData, conversationId });
		return { id: conversationId, type: "group", title: "Test", hidden: false };
	},
};

vi.mock("@/modules/messaging/messaging.service", () => ({
	MessagingService: { getInstance: () => fakeService },
}));

describe("messages lifecycle wire contract", () => {
	const AUTH_ID = SESSION.authId;
	let app: Hono;
	let token: string;

	beforeAll(async () => {
		vi.resetModules();

		const [jwtMod, routes] = await Promise.all([
			import("@/services/jwt.service"),
			import("@/modules/messaging/messaging.routes"),
		]);
		token = jwtMod.JwtService.getInstance().generateToken(AUTH_ID);

		app = new Hono();
		app.route(
			"/api/v1/messages",
			(routes as { messagingRouter: Hono }).messagingRouter,
		);
	});

	const get = (path: string) =>
		app.request(path, { headers: { Authorization: `Bearer ${token}` } });

	it("requires auth", async () => {
		const res = await app.request("/api/v1/messages/conversations");
		expect(res.status).toBe(401);
	});

	it("lists without hidden rows by default", async () => {
		mockCalls.list.length = 0;
		const res = await get("/api/v1/messages/conversations");
		expect(res.status).toBe(200);
		expect(mockCalls.list).toEqual([{ includeHidden: false }]);
	});

	it("passes includeHidden through when the client asks", async () => {
		mockCalls.list.length = 0;
		const res = await get("/api/v1/messages/conversations?includeHidden=1");
		expect(res.status).toBe(200);
		expect(mockCalls.list).toEqual([{ includeHidden: true }]);

		const body = (await res.json()) as {
			data: { data: { hidden: boolean }[] };
		};
		expect(body.data.data[0]!.hidden).toBe(true);
	});

	it("rejects an invalid includeHidden value", async () => {
		mockCalls.list.length = 0;
		const res = await get("/api/v1/messages/conversations?includeHidden=banana");
		expect(res.status).toBe(400);
		expect(mockCalls.list).toHaveLength(0);
	});

	it("unhides the conversation named in the path", async () => {
		mockCalls.unhide.length = 0;
		const res = await app.request("/api/v1/messages/conversations/7/unhide", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);
		expect(mockCalls.unhide).toHaveLength(1);
		expect(mockCalls.unhide[0].conversationId).toBe(7);
		expect(mockCalls.unhide[0].authData.id).toBe(42);

		const body = (await res.json()) as {
			data: { data: { id: number; hidden: boolean } };
		};
		expect(body.data.data).toMatchObject({ id: 7, hidden: false });
	});
});
