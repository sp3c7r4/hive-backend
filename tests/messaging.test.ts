import { describe, it, expect } from "vitest";
import { testApp } from "./setup";

const auth = { "Content-Type": "application/json" };

describe("messaging routes — auth required", () => {
	it("GET /conversations returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/messages/conversations", { headers: auth });
		expect(res.status).toBe(401);
	});

	it("POST /conversations returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/messages/conversations", {
			method: "POST",
			body: JSON.stringify({ participantId: 5 }),
			headers: auth,
		});
		expect(res.status).toBe(401);
	});

	it("GET /conversations/:id/messages returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/messages/conversations/1/messages", {
			headers: auth,
		});
		expect(res.status).toBe(401);
	});

	it("POST /conversations/:id/read returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/messages/conversations/1/read", {
			method: "POST",
			headers: auth,
		});
		expect(res.status).toBe(401);
	});

	it("POST /messages returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/messages/messages", {
			method: "POST",
			body: JSON.stringify({ recipientId: 5, content: "hi" }),
			headers: auth,
		});
		expect(res.status).toBe(401);
	});

	it("DELETE /messages/:id returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/messages/messages/1", {
			method: "DELETE",
			headers: auth,
		});
		expect(res.status).toBe(401);
	});
});
