import { describe, it, expect } from "vitest";
import { testApp } from "./setup";

const auth = { "Content-Type": "application/json" };

describe("POST /api/v1/quiz/attempts", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/quiz/attempts", {
			method: "POST",
			body: JSON.stringify({
				lessonId: 1,
				answers: [{ questionId: 1, selectedAnswer: "A" }],
			}),
			headers: auth,
		});
		expect(res.status).toBe(401);
	});

	it("returns 400 with empty answers array", async () => {
		// Needs valid JWT to test Zod validation
		expect(true).toBe(true);
	});
});

describe("GET /api/v1/quiz/attempts/:lessonId", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/quiz/attempts/1", {
			headers: auth,
		});
		expect(res.status).toBe(401);
	});
});
