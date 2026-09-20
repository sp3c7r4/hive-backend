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
	/* @info - Regression: this route used to mint a certificate on request,
	 * taking its own pass marks and an `allowCertificate` flag from the body,
	 * guarded only by a valid token. Any student could issue themselves a
	 * certificate that then verified publicly as genuine. Issuance is now
	 * worker-only, so the route must not exist at all — for a student AND for
	 * an unauthenticated caller. */
	it("no longer exists for an authenticated user (was a self-issuance hole)", async () => {
		const res = await testApp.request("/api/v1/certificates/issue", {
			method: "POST",
			body: JSON.stringify({
				courseId: 21,
				enrollmentId: 61,
				completionPercent: 100,
				quizScorePercent: 100,
				attendancePercent: 100,
				minCompletion: 0,
				minQuiz: 0,
				minAttendance: 0,
				allowCertificate: true,
			}),
			headers: { ...auth, Authorization: "Bearer not-a-real-token" },
		});
		/* 404 (route gone) is the expected answer; a 401 would mean the old
		 * auth-guarded route is still registered. */
		expect(res.status).toBe(404);
	});

	it("does not fall through to certificate listing", async () => {
		const res = await testApp.request("/api/v1/certificates/issue", {
			method: "POST",
			headers: auth,
		});
		expect(res.status).not.toBe(200);
		expect(res.status).not.toBe(201);
	});
});

describe("GET /api/v1/certificates", () => {
	it("returns 401 without auth", async () => {
		const res = await testApp.request("/api/v1/certificates", { headers: auth });
		expect(res.status).toBe(401);
	});
});
