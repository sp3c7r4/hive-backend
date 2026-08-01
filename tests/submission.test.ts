import { describe, it, expect } from "vitest";
import { testApp } from "./setup";

const auth = { "Content-Type": "application/json" };

describe("GET /api/v1/submissions/courses/:courseId", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/submissions/courses/1", {
			headers: auth,
		});
		expect(res.status).toBe(401);
	});
});

describe("GET /api/v1/submissions/:submissionId", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/submissions/1", {
			headers: auth,
		});
		expect(res.status).toBe(401);
	});
});

describe("PATCH /api/v1/submissions/:submissionId/grade", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/submissions/1/grade", {
			method: "PATCH",
			body: JSON.stringify({ score: 85, action: "grade" }),
			headers: auth,
		});
		expect(res.status).toBe(401);
	});
});

describe("PATCH /api/v1/submissions/lessons/:lessonId/settings", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/submissions/lessons/1/settings", {
			method: "PATCH",
			body: JSON.stringify({ maxScore: 100 }),
			headers: auth,
		});
		expect(res.status).toBe(401);
	});
});
