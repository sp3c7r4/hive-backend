import { describe, it, expect } from "vitest";
import { testApp } from "./setup";

/**
 * These tests verify that the guards block unauthenticated requests.
 * Full guard logic tests (verified email, admin flag) require a valid JWT
 * with specific authData claims — to be wired once the test auth helper is built.
 */

describe("requireEmailVerified guard", () => {
	it("blocks unauthenticated request with 401", async () => {
		// Any protected route without JWT should 401
		const res = await testApp.request("/api/v1/upload/presigned", {
			method: "POST",
			body: JSON.stringify({ contentType: "image/png", filename: "test.png" }),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(401);
	});
});

describe("requireAdmin guard", () => {
	it("blocks unauthenticated request with 401", async () => {
		const res = await testApp.request("/api/v1/upload/presigned", {
			method: "POST",
			body: JSON.stringify({ contentType: "image/png", filename: "test.png" }),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(401);
	});
});
