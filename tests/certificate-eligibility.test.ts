import { describe, expect, it } from "vitest";
import {
	type CertificateEligibilityInput,
	evaluateCertificateEligibility,
} from "@/helpers/certificate-eligibility";

/* ─── Builders ─────────────────────────────────────────────── */

const lessons = (count: number, from = 1): number[] =>
	Array.from({ length: count }, (_, i) => from + i);

const quiz = (over: Partial<CertificateEligibilityInput["quizLessons"][number]> = {}) => ({
	lessonId: 100,
	title: "Quiz One",
	totalQuestions: 10,
	correctAnswers: 8,
	attempted: true,
	...over,
});

const base = (
	over: Partial<CertificateEligibilityInput> = {},
): CertificateEligibilityInput => ({
	offerCertificate: true,
	minCompletionPercent: 80,
	minQuizScorePercent: 0,
	publishedLessonIds: lessons(4),
	completedLessonIds: lessons(4),
	quizLessons: [],
	...over,
});

const quizRequirement = (
	result: ReturnType<typeof evaluateCertificateEligibility>,
	lessonId: number,
) => result.requirements.find((r) => r.quizLessonId === lessonId);

/* ─── Tests ────────────────────────────────────────────────── */

describe("evaluateCertificateEligibility — gates", () => {
	it("refuses when the course does not offer certificates", () => {
		const result = evaluateCertificateEligibility(
			base({ offerCertificate: false }),
		);
		expect(result.eligible).toBe(false);
		expect(result.reason).toBe("This course does not offer certificates.");
	});

	it("refuses when the course has no published lessons", () => {
		const result = evaluateCertificateEligibility(
			base({ publishedLessonIds: [], completedLessonIds: [] }),
		);
		expect(result.eligible).toBe(false);
		expect(result.completionPercent).toBe(0);
		expect(result.reason).toBe("This course has no published lessons.");
	});

	it("ignores completions recorded against draft lessons", () => {
		/* 2 published + 4 drafts, all 6 completed → completion is 2/2, not 6/6. */
		const result = evaluateCertificateEligibility(
			base({
				publishedLessonIds: [1, 2],
				completedLessonIds: [1, 2, 3, 4, 5, 6],
			}),
		);
		expect(result.completionPercent).toBe(100);
		expect(result.eligible).toBe(true);
	});

	it("is not fooled by a draft lesson that was completed while published lessons remain undone", () => {
		const result = evaluateCertificateEligibility(
			base({
				publishedLessonIds: [1, 2, 3, 4],
				completedLessonIds: [1, 5, 6, 7],
			}),
		);
		expect(result.completionPercent).toBe(25);
		expect(result.eligible).toBe(false);
	});
});

describe("evaluateCertificateEligibility — completion", () => {
	const cases: Array<[string, number, number, number, boolean]> = [
		["all four of four complete at an 80% threshold", 4, 4, 80, true],
		["exactly at threshold", 4, 4, 100, true],
		["one below threshold", 4, 1, 80, false],
		["three of four complete at an 80% threshold", 4, 3, 80, false],
		["three of four complete at a 75% threshold", 4, 3, 75, true],
	];

	for (const [name, total, done, threshold, expected] of cases) {
		it(`${expected ? "passes" : "fails"} when ${name}`, () => {
			const result = evaluateCertificateEligibility(
				base({
					publishedLessonIds: lessons(total),
					completedLessonIds: lessons(done),
					minCompletionPercent: threshold,
				}),
			);
			expect(result.eligible).toBe(expected);
			expect(result.requirements[0]).toMatchObject({
				kind: "completion",
				required: threshold,
				actual: Math.round((done / total) * 100),
			});
		});
	}

	it("reports the completion requirement as unmet when below threshold", () => {
		const result = evaluateCertificateEligibility(
			base({ completedLessonIds: lessons(2), minCompletionPercent: 80 }),
		);
		expect(result.requirements[0]?.met).toBe(false);
		expect(result.reason).toContain("80%");
		expect(result.reason).toContain("50%");
	});
});

describe("evaluateCertificateEligibility — quizzes not required", () => {
	it("passes with no quizzes at all, even at a high threshold", () => {
		const result = evaluateCertificateEligibility(
			base({ minQuizScorePercent: 70 }),
		);
		expect(result.eligible).toBe(true);
		expect(result.quizScorePercent).toBeNull();
		expect(result.requirements).toHaveLength(1);
	});

	it("passes when quizzes exist but the threshold is 0 and none were attempted", () => {
		const result = evaluateCertificateEligibility(
			base({
				minQuizScorePercent: 0,
				quizLessons: [
					quiz({ lessonId: 64, attempted: false, correctAnswers: 0 }),
				],
			}),
		);
		expect(result.eligible).toBe(true);
		expect(result.quizScorePercent).toBeNull();
		/* No quiz requirement is emitted at all when quizzes are optional. */
		expect(quizRequirement(result, 64)).toBeUndefined();
	});
});

describe("evaluateCertificateEligibility — quizzes required", () => {
	const withQuiz = (over: Partial<CertificateEligibilityInput> = {}) =>
		base({ minQuizScorePercent: 70, ...over });

	it("fails an unattempted quiz with state not_attempted and a null score, never 0", () => {
		const result = evaluateCertificateEligibility(
			withQuiz({
				quizLessons: [
					quiz({
						lessonId: 64,
						title: "Types of AI Agents",
						attempted: false,
						correctAnswers: 0,
					}),
				],
			}),
		);
		expect(result.eligible).toBe(false);
		expect(quizRequirement(result, 64)).toMatchObject({
			met: false,
			state: "not_attempted",
			actual: null,
			required: 70,
			quizTitle: "Types of AI Agents",
		});
		expect(result.reason).toContain("has not been attempted");
	});

	it("passes a quiz at the threshold", () => {
		const result = evaluateCertificateEligibility(
			withQuiz({
				quizLessons: [
					quiz({ lessonId: 64, totalQuestions: 10, correctAnswers: 7 }),
				],
			}),
		);
		expect(result.eligible).toBe(true);
		expect(result.quizScorePercent).toBe(70);
		expect(quizRequirement(result, 64)?.state).toBe("passed");
	});

	it("fails a quiz one point below the threshold", () => {
		const result = evaluateCertificateEligibility(
			withQuiz({
				quizLessons: [
					quiz({ lessonId: 64, totalQuestions: 10, correctAnswers: 6 }),
				],
			}),
		);
		expect(result.eligible).toBe(false);
		expect(quizRequirement(result, 64)).toMatchObject({
			state: "failed",
			actual: 60,
		});
	});

	it("scores against total questions, so unanswered questions are penalised", () => {
		/* One correct answer out of a five-question quiz is 20%, not 100%. */
		const result = evaluateCertificateEligibility(
			withQuiz({
				quizLessons: [
					quiz({ lessonId: 64, totalQuestions: 5, correctAnswers: 1 }),
				],
			}),
		);
		expect(quizRequirement(result, 64)?.actual).toBe(20);
		expect(result.eligible).toBe(false);
	});

	it("evaluates each quiz independently and passes only when all pass", () => {
		const result = evaluateCertificateEligibility(
			withQuiz({
				quizLessons: [
					quiz({ lessonId: 64, title: "First", correctAnswers: 9 }),
					quiz({ lessonId: 65, title: "Second", correctAnswers: 5 }),
				],
			}),
		);
		expect(result.eligible).toBe(false);
		expect(quizRequirement(result, 64)?.met).toBe(true);
		expect(quizRequirement(result, 65)?.met).toBe(false);
		expect(result.requirements.filter((r) => r.kind === "quiz")).toHaveLength(2);
	});

	it("fails when one quiz passes and another was never attempted", () => {
		const result = evaluateCertificateEligibility(
			withQuiz({
				quizLessons: [
					quiz({ lessonId: 64, title: "First", correctAnswers: 9 }),
					quiz({
						lessonId: 65,
						title: "Second",
						attempted: false,
						correctAnswers: 0,
					}),
				],
			}),
		);
		expect(result.eligible).toBe(false);
		expect(quizRequirement(result, 65)?.state).toBe("not_attempted");
	});

	it("reports the weakest quiz score, not an average", () => {
		const result = evaluateCertificateEligibility(
			withQuiz({
				minQuizScorePercent: 50,
				quizLessons: [
					quiz({ lessonId: 64, correctAnswers: 10 }),
					quiz({ lessonId: 65, correctAnswers: 6 }),
				],
			}),
		);
		expect(result.eligible).toBe(true);
		expect(result.quizScorePercent).toBe(60);
	});

	it("skips a quiz lesson with no authored questions instead of blocking on it", () => {
		/* An empty quiz can never be attempted; requiring it would make the
		 * certificate permanently unreachable. */
		const result = evaluateCertificateEligibility(
			withQuiz({
				quizLessons: [
					quiz({ lessonId: 64, totalQuestions: 0, attempted: false }),
				],
			}),
		);
		expect(result.eligible).toBe(true);
		expect(quizRequirement(result, 64)).toBeUndefined();
		expect(result.quizScorePercent).toBeNull();
	});

	it("returns null quizScorePercent when no quiz was attempted", () => {
		const result = evaluateCertificateEligibility(
			withQuiz({
				quizLessons: [quiz({ lessonId: 64, attempted: false })],
			}),
		);
		expect(result.quizScorePercent).toBeNull();
	});

	it("still requires completion when every quiz passes", () => {
		const result = evaluateCertificateEligibility(
			withQuiz({
				completedLessonIds: lessons(2),
				quizLessons: [quiz({ lessonId: 64, correctAnswers: 10 })],
			}),
		);
		expect(result.eligible).toBe(false);
		expect(result.reason).toContain("Finish 80%");
	});
});

describe("evaluateCertificateEligibility — regression: the reported failures", () => {
	it("§2A — 100% complete with an unattempted quiz is ineligible, and says why", () => {
		/* The reproduction that prompted this work: six of six lessons complete,
		 * certificates switched on, quiz never opened. The student was refused
		 * with a 0% quiz score and no explanation. */
		const result = evaluateCertificateEligibility({
			offerCertificate: true,
			minCompletionPercent: 80,
			minQuizScorePercent: 70,
			publishedLessonIds: [61, 62, 63, 64, 311, 321],
			completedLessonIds: [61, 62, 63, 64, 311, 321],
			quizLessons: [
				{
					lessonId: 64,
					title: "Types of AI Agents",
					totalQuestions: 5,
					correctAnswers: 0,
					attempted: false,
				},
			],
		});

		expect(result.completionPercent).toBe(100);
		expect(result.eligible).toBe(false);
		expect(result.quizScorePercent).toBeNull();
		expect(quizRequirement(result, 64)).toMatchObject({
			state: "not_attempted",
			actual: null,
		});
		expect(result.reason).toBe(
			'"Types of AI Agents" has not been attempted.',
		);
	});

	it("§? — a completed course with no quizzes and no assignments is certifiable", () => {
		const result = evaluateCertificateEligibility(
			base({
				minQuizScorePercent: 70,
				publishedLessonIds: [1, 2, 3],
				completedLessonIds: [1, 2, 3],
			}),
		);
		expect(result.eligible).toBe(true);
		expect(result.requirements).toHaveLength(1);
	});
});
