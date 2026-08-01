import { describe, it, expect } from "vitest";
import { testApp } from "./setup";

const auth = { "Content-Type": "application/json" };

describe("POST /api/v1/courses", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/courses", {
			method: "POST",
			body: JSON.stringify({ communityId: 1, title: "Test Course" }),
			headers: auth,
		});
		expect(res.status).toBe(401);
	});
});

describe("GET /api/v1/courses", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/courses", { headers: auth });
		expect(res.status).toBe(401);
	});
});

describe("GET /api/v1/courses/:id", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/courses/1", { headers: auth });
		expect(res.status).toBe(401);
	});
});

describe("POST /api/v1/courses/:courseId/modules", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/courses/1/modules", {
			method: "POST",
			body: JSON.stringify({ title: "Module 1" }),
			headers: auth,
		});
		expect(res.status).toBe(401);
	});
});

describe("GET /api/v1/courses/:courseId/modules", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/courses/1/modules", { headers: auth });
		expect(res.status).toBe(401);
	});
});

describe("POST /api/v1/modules/:moduleId/lessons", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/modules/1/lessons", {
			method: "POST",
			body: JSON.stringify({ title: "Lesson 1" }),
			headers: auth,
		});
		expect(res.status).toBe(401);
	});
});

describe("GET /api/v1/modules/:moduleId/lessons", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/modules/1/lessons", { headers: auth });
		expect(res.status).toBe(401);
	});
});
