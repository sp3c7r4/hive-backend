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
			{
				userId: 1,
				name: "Ada E.",
				completed: 1,
				total: 2,
				averagePercent: 100,
				reason: "partial",
			},
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
				averagePercent: null,
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

describe("rankLeaderboard — the number and the order the module board needs", () => {
	/* @info - Three assessments in scope, so coverage, average and time can be varied
	 * independently of each other. */
	const three: LeaderboardAssessment[] = [
		{ lessonId: 1, title: "Assessment 1" },
		{ lessonId: 2, title: "Assessment 2" },
		{ lessonId: 3, title: "Assessment 3" },
	];

	it("averages the shown percentages for a student who closed part of the scope", () => {
		/* @info - 1 of 8 is 12.5% and 3 of 8 is 37.5%. The screen shows 13% and 38%,
		 * whose mean is 25.5 and rounds to 26. Averaging the raw fractions first would
		 * give 25, so this is the case that pins which of the two the board does. */
		const { unranked } = rankLeaderboard({
			assessments: three,
			students: [
				student(1, "Ada E.", [session(1, 1, 8, 10), session(2, 3, 8, 10)]),
			],
		});

		expect(first(unranked)).toMatchObject({
			userId: 1,
			completed: 2,
			total: 3,
			averagePercent: 26,
			reason: "partial",
		});
	});

	it("gives a ranked row the same number it had before the maths was shared", () => {
		const { rows } = rankLeaderboard({
			assessments,
			students: [
				student(1, "Ada E.", [session(1, 1, 8, 10), session(2, 3, 8, 10)]),
			],
		});

		expect(first(rows).averagePercent).toBe(26);
	});

	it("orders the unranked by coverage before score", () => {
		const { unranked } = rankLeaderboard({
			assessments: three,
			students: [
				student(1, "Sat two", [session(1, 1, 4, 10), session(2, 1, 4, 10)]),
				student(2, "Sat one", [session(1, 4, 4, 10)]),
			],
		});

		expect(unranked.map((entry) => entry.userId)).toEqual([1, 2]);
		expect(unranked.map((entry) => entry.averagePercent)).toEqual([25, 100]);
	});

	it("breaks a coverage and score tie by time", () => {
		const { unranked } = rankLeaderboard({
			assessments,
			students: [
				student(1, "Aaa slow", [session(1, 4, 4, 20)]),
				student(2, "Zzz quick", [session(1, 4, 4, 10)]),
			],
		});

		/* @info - The name and the id both point the other way, so only the time decides
		 * this order. A name-first sort would put "Aaa slow" first, and an id-first one
		 * would put user 1 first; the current code does both, so this is red until D7. */
		expect(unranked.map((entry) => entry.userId)).toEqual([2, 1]);
	});

	it("breaks a full tie by userId, in either input order", () => {
		/* @info - Same coverage, same average and same time, and the same display name,
		 * which is a first name plus a last initial and can repeat. Expecting the list
		 * twice from one input order proves nothing about a sort, so the same students
		 * are passed in both orders and the two results must be identical. */
		const students = [
			student(9, "Ada E.", [session(1, 4, 4, 10)]),
			student(3, "Ada E.", [session(1, 4, 4, 10)]),
		];

		const forward = rankLeaderboard({ assessments, students });
		const reversed = rankLeaderboard({
			assessments,
			students: [...students].reverse(),
		});

		expect(forward.unranked.map((entry) => entry.userId)).toEqual([3, 9]);
		expect(reversed.unranked).toEqual(forward.unranked);
	});

	it("ranks nobody and orders everyone by coverage when the scope is twelve assessments", () => {
		const twelve: LeaderboardAssessment[] = Array.from(
			{ length: 12 },
			(_, index) => ({ lessonId: index + 1, title: `Week ${index + 1}` }),
		);
		const elevenOfTwelve = (score: number) =>
			twelve
				.slice(0, 11)
				.map((assessment) =>
					session(assessment.lessonId, score, 100, 10),
				);

		const { rows, unranked } = rankLeaderboard({
			assessments: twelve,
			students: [
				student(1, "Eleven at sixty", elevenOfTwelve(60)),
				student(2, "Eleven at ninety", elevenOfTwelve(90)),
				student(3, "Two at a hundred", [
					session(1, 100, 100, 10),
					session(2, 100, 100, 10),
				]),
			],
		});

		expect(rows).toEqual([]);
		expect(unranked.map((entry) => entry.userId)).toEqual([2, 1, 3]);
		expect(unranked.map((entry) => entry.completed)).toEqual([11, 11, 2]);
		expect(unranked.map((entry) => entry.averagePercent)).toEqual([90, 60, 100]);
	});
});
