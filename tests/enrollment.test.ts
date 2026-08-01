import { describe, it, expect } from "vitest";
import { testApp } from "./setup";

const auth = { "Content-Type": "application/json" };

describe("POST /api/v1/enrollments", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/enrollments", {
			method: "POST",
			body: JSON.stringify({ courseId: 1 }),
			headers: auth,
		});
		expect(res.status).toBe(401);
	});
});

describe("GET /api/v1/enrollments", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/enrollments", { headers: auth });
		expect(res.status).toBe(401);
	});
});

describe("GET /api/v1/enrollments/:id", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/enrollments/1", { headers: auth });
		expect(res.status).toBe(401);
	});
});

describe("PATCH /api/v1/enrollments/:id/progress/:lessonId", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/enrollments/1/progress/1", {
			method: "PATCH",
			headers: auth,
		});
		expect(res.status).toBe(401);
	});
});

describe("GET /api/v1/enrollments/:id/progress", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/enrollments/1/progress", {
			headers: auth,
		});
		expect(res.status).toBe(401);
	});
});
