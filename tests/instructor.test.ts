import { describe, it, expect } from "vitest";
import { testApp } from "./setup";

const auth = { "Content-Type": "application/json" };

describe("GET /api/v1/instructor/stats", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/instructor/stats", {
			headers: auth,
		});
		expect(res.status).toBe(401);
	});
});

describe("GET /api/v1/instructor/live-classes", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/instructor/live-classes", {
			headers: auth,
		});
		expect(res.status).toBe(401);
	});
});

describe("GET /api/v1/communities/:slug/analytics", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/communities/test-community/analytics", {
			headers: auth,
		});
		expect(res.status).toBe(401);
	});
});
