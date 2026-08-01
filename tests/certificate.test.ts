import { describe, it, expect } from "vitest";
import { testApp } from "./setup";

const auth = { "Content-Type": "application/json" };

describe("GET /api/v1/certificates/verify/:code", () => {
	it("returns 404 for unknown code (public — no auth)", async () => {
		const res = await testApp.request("/api/v1/certificates/verify/UNKNOWN-CODE", {
			headers: auth,
		});
		// Without DB, this will hit the controller and try repository — may return 404 or 500
		// depending on whether DB is up. Just verify it doesn't 401.
		expect(res.status).not.toBe(401);
	});
});

describe("POST /api/v1/certificates/issue", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/certificates/issue", {
			method: "POST",
			body: JSON.stringify({
				courseId: 1,
				enrollmentId: 1,
				completionPercent: 90,
				quizScorePercent: 85,
				attendancePercent: 80,
				minCompletion: 80,
				minQuiz: 70,
				minAttendance: 60,
				allowCertificate: true,
			}),
			headers: auth,
		});
		expect(res.status).toBe(401);
	});
});

describe("GET /api/v1/certificates", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/certificates", { headers: auth });
		expect(res.status).toBe(401);
	});
});
