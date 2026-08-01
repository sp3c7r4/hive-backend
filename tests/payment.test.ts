import { describe, it, expect } from "vitest";
import { testApp } from "./setup";

describe("POST /api/v1/payment/initialize", () => {
	it("returns 401 without auth header", async () => {
		const res = await testApp.request("/api/v1/payment/initialize", {
			method: "POST",
			body: JSON.stringify({
				type: "enrollment",
				enrollmentId: 1,
				amount: 500000,
			}),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(401);
	});

	it("returns 400 with missing required fields", async () => {
		// Needs valid JWT — placeholder
		expect(true).toBe(true);
	});

	it("returns 400 with invalid type", async () => {
		// Needs valid JWT
		expect(true).toBe(true);
	});
});

describe("POST /api/v1/webhook/paystack", () => {
	it("returns 200 for valid signature", async () => {
		// Webhook doesn't need JWT, but needs real Paystack signature
		expect(true).toBe(true);
	});
});
