import { describe, it, expect, vi, beforeEach } from "vitest";

/* Mocks — the service captures repository/queue instances at construction,
 * so we mock the modules and return shared fakes from getInstance().
 *
 * NOTE: tests/setup.ts imports the whole route graph BEFORE this file runs,
 * which caches the real repository module. We call vi.resetModules() in
 * beforeEach and load the service with a dynamic import so the mocks win. */
const mocks = vi.hoisted(() => {
	const submissionRepo = {
		findByUserAndLesson: vi.fn(),
		update: vi.fn(),
		create: vi.fn(),
		findById: vi.fn(),
	};
	const lessonRepo = { findById: vi.fn() };
	const emailAdd = vi.fn();
	const dbRow = { email: "vekogep220@murkstar.com", firstName: "Testing" };
	const queryChain = { limit: vi.fn(async () => [dbRow]) };
	const db = {
		select: vi.fn(() => ({
			from: vi.fn(() => ({ where: vi.fn(() => queryChain) })),
		})),
	};
	return { submissionRepo, lessonRepo, emailAdd, db };
});

vi.mock("@/modules/assessments/submission.repository", () => ({
	AssignmentSubmissionRepository: { getInstance: () => mocks.submissionRepo },
}));
vi.mock("@/modules/courses/course.repository", () => ({
	LessonRepository: { getInstance: () => mocks.lessonRepo },
}));
vi.mock("@/services/queues/email.queue.service", () => ({
	EmailQueueService: { getInstance: () => ({ add: mocks.emailAdd }) },
}));
vi.mock("@/db/postgres.db", () => ({ getDb: () => mocks.db }));

async function loadService() {
	vi.resetModules();
	const { AssignmentService } = await import(
		"@/modules/assessments/submission.service"
	);
	return AssignmentService.getInstance();
}

const auth = { id: 6 } as any;

describe("AssignmentService.submit", () => {
	beforeEach(() => {
		mocks.submissionRepo.findByUserAndLesson.mockReset();
		mocks.submissionRepo.update.mockReset();
		mocks.submissionRepo.create.mockReset();
		mocks.submissionRepo.findByUserAndLesson.mockResolvedValue(null);
	});

	it("clears score/feedback/gradedAt when a resubmission overwrites an existing graded submission", async () => {
		const service = await loadService();
		mocks.submissionRepo.findByUserAndLesson.mockResolvedValue({ id: 1, userId: 6, lessonId: 9 });
		mocks.submissionRepo.update.mockResolvedValue({ id: 1, status: "submitted" });

		await service.submit(auth, 9, "revised answer", ["images/files/general/a.pdf"]);

		expect(mocks.submissionRepo.update).toHaveBeenCalledWith(
			1,
			expect.objectContaining({
				text: "revised answer",
				fileUrls: ["images/files/general/a.pdf"],
				status: "submitted",
				submittedAt: expect.any(Date),
				score: null,
				feedback: null,
				gradedAt: null,
			}),
		);
	});

	it("creates a fresh submission without any grade fields on first submit", async () => {
		const service = await loadService();
		mocks.submissionRepo.create.mockResolvedValue({ id: 2, status: "submitted" });

		await service.submit(auth, 9, "hello", ["images/files/general/b.pdf"]);

		const payload = mocks.submissionRepo.create.mock.calls[0]![0]!;
		expect(payload).toMatchObject({
			userId: 6,
			lessonId: 9,
			text: "hello",
			fileUrls: ["images/files/general/b.pdf"],
			status: "submitted",
		});
		expect(payload).not.toHaveProperty("score");
		expect(payload).not.toHaveProperty("feedback");
		expect(payload).not.toHaveProperty("gradedAt");
	});
});

describe("AssignmentService.grade", () => {
	beforeEach(() => {
		mocks.submissionRepo.findById.mockReset();
		mocks.submissionRepo.update.mockReset();
		mocks.emailAdd.mockReset();
		mocks.submissionRepo.findById.mockResolvedValue({ id: 1, userId: 6, lessonId: 9, maxScore: 100 });
		mocks.submissionRepo.update.mockResolvedValue({ id: 1 });
	});

	it("maps return_for_revision to status 'returned' with gradedAt null", async () => {
		const service = await loadService();

		await service.grade(1, { score: 40, feedback: "revise", action: "return_for_revision" });

		expect(mocks.submissionRepo.update).toHaveBeenCalledWith(
			1,
			expect.objectContaining({
				status: "returned",
				score: 40,
				feedback: "revise",
				gradedAt: null,
			}),
		);
		expect(mocks.emailAdd).not.toHaveBeenCalled();
	});

	it("maps grade to status 'graded' with gradedAt set and queues the email", async () => {
		const service = await loadService();

		await service.grade(1, { score: 90, feedback: "nice work", action: "grade" });

		expect(mocks.submissionRepo.update).toHaveBeenCalledWith(
			1,
			expect.objectContaining({
				status: "graded",
				score: 90,
				feedback: "nice work",
				gradedAt: expect.any(Date),
			}),
		);
		expect(mocks.emailAdd).toHaveBeenCalledTimes(1);
	});
});
