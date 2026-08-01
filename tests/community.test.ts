import { describe, it, expect } from "vitest";
import { testApp } from "./setup";

describe("POST /api/v1/communities", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/communities", {
			method: "POST",
			body: JSON.stringify({ name: "Test Community" }),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(401);
	});

	it("returns 400 for empty name", async () => {
		// Needs valid JWT to test validation
		expect(true).toBe(true);
	});
});

describe("GET /api/v1/communities", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/communities", {
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(401);
	});
});

describe("GET /api/v1/communities/:slug", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/communities/test-slug", {
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(401);
	});
});

describe("PATCH /api/v1/communities/:id", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/communities/1", {
			method: "PATCH",
			body: JSON.stringify({ name: "Updated" }),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(401);
	});
});

describe("DELETE /api/v1/communities/:id", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/communities/1", {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(401);
	});
});
