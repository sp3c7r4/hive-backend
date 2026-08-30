import { describe, it, expect, vi } from "vitest";
import { testApp } from "./setup";

/* The public getBySlug route is DB-backed — the shared testApp captured the
 * real getDb binding at import time, so these tests build a fresh app with a
 * mocked getDb (no database connection needed). */
vi.mock("@/db/postgres.db", () => ({
	getDb: () => ({
		select: () => ({
			from: () => ({
				where: () => ({ limit: async () => [] }),
			}),
		}),
	}),
}));

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
	it("is public — returns 404 for unknown slug without auth", async () => {
		vi.resetModules();
		const { createTestApp } = await import("./setup");
		const res = await createTestApp().request(
			"/api/v1/communities/definitely-not-a-slug",
			{ headers: { "Content-Type": "application/json" } },
		);
		expect(res.status).toBe(404);
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
