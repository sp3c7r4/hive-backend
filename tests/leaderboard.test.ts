import { describe, expect, it } from "vitest";
import {
	type LeaderboardAssessment,
	type LeaderboardStudent,
	rankLeaderboard,
} from "@/modules/assessments/leaderboard";

/**
 * @info - The ranking rules from spec §6, as cases rather than prose.
 *
 * The board exists to order students, so the two things that decide the order are
 * what matter: the score, and time taken when the score ties. Everything else here
 * is about who is deliberately NOT on it — a student with a half-finished set is
 * listed with their coverage instead of being ranked on a partial run, but a
 * student who took every assessment and scored nothing has taken them and is
 * ranked last, not hidden.
 *
 * No database and no clock: the caller passes closed sessions only, so every
 * session here is one that counts.
 */

/** @info - `noUncheckedIndexedAccess` is on: reading an index is optional, and a
 *  test that asserts on a row which is not there should say so, not crash. */
const first = <T>(items: T[]): T => {
	const [head] = items;
	if (!head) throw new Error("expected at least one item");
	return head;
};
const second = <T>(items: T[]): T => first(items.slice(1));

const assessments: LeaderboardAssessment[] = [
	{ lessonId: 1, title: "Mid-term" },
	{ lessonId: 2, title: "Final" },
];

/** @info - A closed session. `minutes` is how long they took, end to end. */
const session = (
	lessonId: number,
	correct: number,
	total: number,
	minutes: number,
) => {
	const startedAt = new Date("2026-09-01T10:00:00.000Z");
	return {
		lessonId,
		correct,
		total,
		startedAt,
		submittedAt: new Date(startedAt.getTime() + minutes * 60_000),
		deadline: null,
	};
};

const student = (
	userId: number,
	name: string,
	sessions: ReturnType<typeof session>[],
): LeaderboardStudent => ({ userId, name, sessions });

describe("rankLeaderboard — who is ranked", () => {
	it("ranks a student with a closed session on every assessment, including at 0%", () => {
		const { rows, unranked } = rankLeaderboard({
			assessments,
			students: [
				student(1, "Ada E.", [session(1, 0, 4, 10), session(2, 0, 2, 5)]),
			],
		});
		expect(unranked).toEqual([]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			rank: 1,
			userId: 1,
			name: "Ada E.",
			averagePercent: 0,
			completed: 2,
			total: 2,
		});
	});

	it("lists a student missing an assessment as partial, with their coverage", () => {
		const { rows, unranked } = rankLeaderboard({
			assessments,
			students: [student(1, "Ada E.", [session(1, 4, 4, 10)])],
		});
		expect(rows).toEqual([]);
		expect(unranked).toEqual([
			{ userId: 1, name: "Ada E.", completed: 1, total: 2, reason: "partial" },
		]);
	});

	it("lists a student with no sessions as not_started", () => {
		const { unranked } = rankLeaderboard({
			assessments,
			students: [student(7, "Tunde O.", [])],
		});
		expect(unranked).toEqual([
			{
				userId: 7,
				name: "Tunde O.",
				completed: 0,
				total: 2,
				reason: "not_started",
			},
		]);
	});

	it("returns both lists empty when the course has no assessments", () => {
		const { rows, unranked } = rankLeaderboard({
			assessments: [],
			students: [student(1, "Ada E.", []), student(2, "Tunde O.", [])],
		});
		expect(rows).toEqual([]);
		expect(unranked).toEqual([]);
	});
});

describe("rankLeaderboard — how they are ordered", () => {
	it("breaks a score tie by time taken", () => {
		const { rows } = rankLeaderboard({
			assessments,
			students: [
				student(1, "Slow S.", [session(1, 4, 4, 30), session(2, 2, 2, 30)]),
				student(2, "Quick Q.", [session(1, 4, 4, 5), session(2, 2, 2, 5)]),
			],
		});
		expect(rows.map((r) => r.name)).toEqual(["Quick Q.", "Slow S."]);
		expect(first(rows).rank).toBe(1);
		expect(first(rows).totalTimeSeconds).toBe(600);
		expect(second(rows).totalTimeSeconds).toBe(3600);
	});

	it("breaks an exact score and time tie by userId ascending", () => {
		const { rows } = rankLeaderboard({
			assessments,
			students: [
				student(9, "Later L.", [session(1, 4, 4, 10), session(2, 2, 2, 10)]),
				student(3, "Earlier E.", [session(1, 4, 4, 10), session(2, 2, 2, 10)]),
			],
		});
		expect(rows.map((r) => r.userId)).toEqual([3, 9]);
		expect(rows.map((r) => r.rank)).toEqual([1, 2]);
	});

	it("orders by average percentage, best first, with ranks in sequence", () => {
		const { rows } = rankLeaderboard({
			assessments,
			students: [
				student(1, "Low L.", [session(1, 1, 4, 10), session(2, 0, 2, 10)]),
				student(2, "High H.", [session(1, 4, 4, 10), session(2, 2, 2, 10)]),
				student(3, "Middle M.", [session(1, 2, 4, 10), session(2, 1, 2, 10)]),
			],
		});
		expect(rows.map((r) => [r.rank, r.name, r.averagePercent])).toEqual([
			[1, "High H.", 100],
			[2, "Middle M.", 50],
			/* 25% and 0% -> 12.5 -> 13: the mean of the two assessments. */
			[3, "Low L.", 13],
		]);
	});

	it("averages the assessments as a mean, not a win or a worst case", () => {
		const { rows } = rankLeaderboard({
			assessments,
			students: [
				/* 100% and 0% -> 50, not 100 (any pass) and not 0 (worst) */
				student(1, "Mixed M.", [session(1, 4, 4, 10), session(2, 0, 2, 10)]),
			],
		});
		expect(first(rows).averagePercent).toBe(50);
	});

	it("counts unanswered questions as wrong", () => {
		const { rows } = rankLeaderboard({
			assessments: [first(assessments)],
			students: [
				/* One of four authored questions answered correctly: 25%, not 100%. */
				student(1, "Partial P.", [session(1, 1, 4, 10)]),
			],
		});
		expect(first(rows).averagePercent).toBe(25);
	});

	it("rounds each assessment before averaging, so the mean is of the shown numbers", () => {
		const { rows } = rankLeaderboard({
			assessments,
			/* 1/3 -> 33% and 2/3 -> 67%, and their mean is 50 — the number the screen
			 * shows for each is the one that is averaged, not the raw fractions. */
			students: [
				student(1, "Rounding R.", [session(1, 1, 3, 10), session(2, 2, 3, 10)]),
			],
		});
		expect(first(rows).averagePercent).toBe(50);
	});
});
