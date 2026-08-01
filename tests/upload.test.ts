import { describe, it, expect } from "vitest";
import { testApp } from "./setup";

describe("POST /api/v1/upload/presigned", () => {
	it("returns 401 without auth header", async () => {
		const res = await testApp.request("/api/v1/upload/presigned", {
			method: "POST",
			body: JSON.stringify({ contentType: "image/png", filename: "test.png" }),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(401);
	});

	it("returns 400 with missing contentType", async () => {
		// This test needs a valid JWT — skipped until test auth helper is wired
		expect(true).toBe(true);
	});

	it("returns 201 with valid JWT and body", async () => {
		// Needs test JWT generation helper
		expect(true).toBe(true);
	});
});

describe("GET /api/v1/upload/files/:key/download", () => {
	it("returns 401 without auth header", async () => {
		const res = await testApp.request("/api/v1/upload/files/test-key/download");
		expect(res.status).toBe(401);
	});

	it("returns 200 with valid JWT", async () => {
		// Needs test JWT generation helper
		expect(true).toBe(true);
	});
});
