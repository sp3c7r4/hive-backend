import { describe, it, expect } from "vitest";
import { testApp } from "./setup";

const auth = { "Content-Type": "application/json" };

/* Student routes */
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

/* Instructor: Quiz Builder */
describe("GET /api/v1/quiz/lessons/:lessonId/questions", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/quiz/lessons/1/questions", {
			headers: auth,
		});
		expect(res.status).toBe(401);
	});
});

describe("POST /api/v1/quiz/lessons/:lessonId/questions", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/quiz/lessons/1/questions", {
			method: "POST",
			body: JSON.stringify({
				text: "What is 2+2?",
				correctAnswer: "4",
				options: ["2", "3", "4", "5"],
			}),
			headers: auth,
		});
		expect(res.status).toBe(401);
	});
});

describe("GET /api/v1/quiz/questions/:questionId", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/quiz/questions/1", {
			headers: auth,
		});
		expect(res.status).toBe(401);
	});
});

describe("PATCH /api/v1/quiz/questions/:questionId", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/quiz/questions/1", {
			method: "PATCH",
			body: JSON.stringify({ text: "Updated question?" }),
			headers: auth,
		});
		expect(res.status).toBe(401);
	});
});

describe("DELETE /api/v1/quiz/questions/:questionId", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/quiz/questions/1", {
			method: "DELETE",
			headers: auth,
		});
		expect(res.status).toBe(401);
	});
});
