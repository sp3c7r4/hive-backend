/**
 * @info - The course leaderboard's ranking rules, as a pure function.
 *
 * No database handle and no clock, for the same reason
 * `helpers/certificate-eligibility.ts` has neither: the rules are the part a person
 * can get wrong, and they are worth testing without a server. The caller gathers
 * plain data — the assessments in scope and, per enrolled student, their CLOSED
 * sessions (submitted, or past the deadline) — and this decides the order.
 *
 * Ranked means one closed session on every assessment in scope. A student with a
 * half-finished set is not ranked on the part they did: "take the easy assessment,
 * skip the hard one" would otherwise be a winning strategy. A student who took
 * every assessment and scored nothing IS ranked, last — the attempt was made.
 *
 * `averagePercent` is deliberately a MEAN. The certificate gate asks a different
 * question and answers it with the worst quiz score, so the two numbers can
 * disagree for the same student; the screen must not present them as the same
 * thing.
 */

export interface LeaderboardAssessment {
	lessonId: number;
	title: string | null;
}

export interface LeaderboardSession {
	lessonId: number;
	/** Questions answered correctly. */
	correct: number;
	/** Questions authored, so unanswered counts as wrong. */
	total: number;
	startedAt: Date | null;
	submittedAt: Date | null;
	deadline: Date | null;
}

export interface LeaderboardStudent {
	userId: number;
	name: string;
	sessions: LeaderboardSession[];
}

export interface LeaderboardRow {
	rank: number;
	userId: number;
	name: string;
	averagePercent: number;
	completed: number;
	total: number;
	totalTimeSeconds: number;
}

export interface LeaderboardUnranked {
	userId: number;
	name: string;
	completed: number;
	total: number;
	reason: "partial" | "not_started";
}

export interface LeaderboardResult {
	rows: LeaderboardRow[];
	unranked: LeaderboardUnranked[];
}

/** @info - Unanswered counts as wrong, which is why the denominator is the number
 *  of authored questions rather than the number answered. */
const percent = (correct: number, total: number): number =>
	total > 0 ? Math.round((correct / total) * 100) : 0;

/**
 * @info - How long the attempt took, end to end. An attempt that ran out of time
 *         has no `submittedAt`, so the deadline stands in for it — the time they
 *         spent is the time the clock allowed.
 */
const secondsTaken = (session: LeaderboardSession): number => {
	const end = session.submittedAt ?? session.deadline;
	if (!session.startedAt || !end) return 0;
	return Math.max(
		0,
		Math.round((end.getTime() - session.startedAt.getTime()) / 1000),
	);
};

export const rankLeaderboard = ({
	assessments,
	students,
}: {
	assessments: LeaderboardAssessment[];
	students: LeaderboardStudent[];
}): LeaderboardResult => {
	/* @info - No assessments in scope means no board: an empty course would
	 * otherwise rank every enrolled student at 0% and mean nothing. */
	if (assessments.length === 0) return { rows: [], unranked: [] };

	const rows: LeaderboardRow[] = [];
	const unranked: LeaderboardUnranked[] = [];

	for (const student of students) {
		const inScope = student.sessions.filter((session) =>
			assessments.some(
				(assessment) => assessment.lessonId === session.lessonId,
			),
		);
		/* @info - One session per assessment per student, enforced by
		 * `uq_assessment_session`, so the count is the coverage. */
		const completed = inScope.length;

		if (completed < assessments.length) {
			unranked.push({
				userId: student.userId,
				name: student.name,
				completed,
				total: assessments.length,
				reason: completed === 0 ? "not_started" : "partial",
			});
			continue;
		}

		const percents = inScope.map((session) =>
			percent(session.correct, session.total),
		);
		const averagePercent = Math.round(
			percents.reduce((sum, value) => sum + value, 0) / percents.length,
		);

		rows.push({
			rank: 0,
			userId: student.userId,
			name: student.name,
			averagePercent,
			completed,
			total: assessments.length,
			totalTimeSeconds: inScope.reduce(
				(sum, session) => sum + secondsTaken(session),
				0,
			),
		});
	}

	/* @info - Score, then time taken ascending (faster wins), then `userId` so two
	 * identical runs still produce a stable board rather than one that reshuffles
	 * between reads. */
	rows.sort(
		(a, b) =>
			b.averagePercent - a.averagePercent ||
			a.totalTimeSeconds - b.totalTimeSeconds ||
			a.userId - b.userId,
	);
	rows.forEach((row, index) => {
		row.rank = index + 1;
	});

	/* @info - The unranked list is a "who is missing what" list, so most-covered
	 * first, then by name for a stable order. */
	unranked.sort(
		(a, b) => b.completed - a.completed || a.name.localeCompare(b.name),
	);

	return { rows, unranked };
};
