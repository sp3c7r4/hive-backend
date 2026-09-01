import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
	const results: any[] = [];
	const chain: any = {
		select: () => chain,
		from: () => chain,
		innerJoin: () => chain,
		where: () => chain,
		orderBy: () => chain,
		groupBy: () => chain,
		limit: () => chain,
		then: async (resolve: any) => resolve(results.shift() ?? []),
	};
	return { db: chain, results };
});

vi.mock("@/db/postgres.db", () => ({ getDb: () => mocks.db }));

async function loadService() {
	vi.resetModules();
	const { StudentDashboardService } = await import("@/modules/student/student.service");
	return StudentDashboardService.getInstance();
}

const auth = { id: 7 } as any;
const enrollRow = {
	enrollmentId: 3,
	courseId: 5,
	title: "Introduction To Typescript",
	slug: "introduction-to-typescript-1",
	coverImageUrl: "images/coverImage/x.jpg",
	instructorName: "Sarafa",
	enrolledAt: new Date("2026-08-30T10:00:00Z"),
};
const assignmentRow = {
	lessonId: 6,
	title: "Assignment",
	settings: { dueDate: "2026-09-15T14:00:00.000Z" },
	courseId: 5,
	courseTitle: "Introduction To Typescript",
	courseSlug: "introduction-to-typescript-1",
};
const certRow = {
	code: "HIVE-2-5-TEST",
	courseTitle: "Introduction To Typescript",
	issuedAt: new Date("2026-08-31T10:00:00Z"),
	time: new Date("2026-08-31T10:00:00Z"),
	fileUrl: "certificates/HIVE-2-5-TEST.png",
};

describe("StudentDashboardService", () => {
	beforeEach(() => {
		mocks.results.length = 0;
	});

	it("dashboard: real progress, due-soon with status, activity + certificates", async () => {
		mocks.results.push(
			[enrollRow], // 1 enrollments
			[{ enrollmentId: 3, total: 5 }], // 2 progress completed
			[{ courseId: 5, total: 6 }], // 3 lesson counts
			[assignmentRow], // 4 assignment lessons
			[{ lessonId: 6, status: "pending" }], // 5 submissions
			[{ id: 1, title: "Bread", amount: 4000000, time: new Date("2026-08-31T09:00:00Z") }], // 6 payments
			[certRow], // 7 certificates (activity)
			[certRow], // 8 certificates (list)
		);
		const service = await loadService();
		const d = await service.dashboard(auth);

		expect(d.continueLearning).toHaveLength(1);
		expect(d.continueLearning[0]).toMatchObject({
			courseId: 5,
			title: "Introduction To Typescript",
			progressPercent: 83,
			instructorName: "Sarafa",
		});
		expect(d.continueLearning[0]!.coverImageUrl).toContain("images/coverImage/x.jpg");

		expect(d.dueSoon).toHaveLength(1);
		expect(d.dueSoon[0]).toMatchObject({
			lessonId: 6,
			dueAt: "2026-09-15T14:00:00.000Z",
			submissionStatus: "pending",
		});

		expect(d.recentActivity).toHaveLength(3);
		expect(d.recentActivity[0]!.type).toBe("certificate"); // newest first
		expect(d.recentActivity[1]!.type).toBe("payment");
		expect(d.recentActivity[1]!.text).toContain("paid ₦40,000");
		expect(d.recentActivity[2]!.type).toBe("enrollment");

		expect(d.certificates).toHaveLength(1);
		expect(d.certificates[0]!.code).toBe("HIVE-2-5-TEST");
		expect(d.certificates[0]!.fileUrl).toContain("certificates/HIVE-2-5-TEST.png");
	});

	it("dashboard: past-due assignments are excluded, empty data → zeros", async () => {
		mocks.results.push(
			[],
			[],
			[],
			[{ ...assignmentRow, settings: { dueDate: "2026-01-01T00:00:00Z" } }],
			[],
			[],
			[],
			[],
		);
		const service = await loadService();
		const d = await service.dashboard(auth);
		expect(d.continueLearning).toHaveLength(0);
		expect(d.dueSoon).toHaveLength(0);
		expect(d.recentActivity).toHaveLength(0);
		expect(d.certificates).toHaveLength(0);
	});
});
