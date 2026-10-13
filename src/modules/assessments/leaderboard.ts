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
 * A student who closed SOME of the scope still carries a number, the mean of the
 * assessments they did close, but they stay in the unranked list and that list is
 * ordered by coverage before score: the partial number informs, it does not compete
 * with a student who sat everything.
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
	/** @info - The mean of the percents they closed, or null when they closed none.
	 *  Never 0 for "no attempts": 0% is a real score, and the two must not read alike. */
	averagePercent: number | null;
	reason: "partial" | "not_started";
}

/**
 * @info - One module's board for the module view (D1): the same three lists the course
 * level carries, narrowed to that module's assessments. A module appears here when it
 * holds at least one assessment lesson of any status, so a module whose only assessment
 * is a draft comes back with empty lists rather than being missing (D3).
 */
export interface LeaderboardModule {
	moduleId: number;
	title: string;
	assessments: LeaderboardAssessment[];
	rows: LeaderboardRow[];
	unranked: LeaderboardUnranked[];
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
 * @info - The mean of the per-assessment percentages, each rounded the way the screen
 * prints it. Rounding the raw fractions first would let a row's average disagree with
 * the mean of the numbers shown beside it (two sessions of 1 of 8 and 3 of 8 are 13%
 * and 38%, whose mean is 26, where the raw fractions average to 25).
 *
 * One copy on purpose: the ranked rows and the unranked entries must not be able to
 * drift into different maths. Callers pass at least one session, and the guard keeps
 * the division total for the empty case rather than returning NaN.
 */
const meanPercent = (sessions: LeaderboardSession[]): number =>
	sessions.length === 0
		? 0
		: Math.round(
				sessions.reduce(
					(sum, session) => sum + percent(session.correct, session.total),
					0,
				) / sessions.length,
			);

/** @info - End to end time over the sessions given, using the same rule the ranked
 *  rows use, so the two lists cannot measure time differently. */
const totalSeconds = (sessions: LeaderboardSession[]): number =>
	sessions.reduce((sum, session) => sum + secondsTaken(session), 0);

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
	/* @info - Time is needed to order the unranked list but is deliberately not part of
	 * its DTO, so it is kept beside the list rather than on the entries. */
	const unrankedSeconds = new Map<number, number>();

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
				averagePercent: completed === 0 ? null : meanPercent(inScope),
				reason: completed === 0 ? "not_started" : "partial",
			});
			unrankedSeconds.set(student.userId, totalSeconds(inScope));
			continue;
		}

		/* @info - A ranked student has one closed session on every assessment in scope,
		 * so `inScope` is never empty on this path. */
		const averagePercent = meanPercent(inScope);

		rows.push({
			rank: 0,
			userId: student.userId,
			name: student.name,
			averagePercent,
			completed,
			total: assessments.length,
			totalTimeSeconds: totalSeconds(inScope),
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

	/* @info - Coverage first, because this is a "who is missing what" list and the ladder
	 * reads better than a scoreboard nobody qualified for; then the score, then the time
	 * they took, then the name and the id so two identical runs cannot reshuffle.
	 *
	 * A null average is treated as the lowest score. It only occurs when nothing was
	 * closed, which always sits in the lowest coverage group, so within a group of equal
	 * coverage it never competes against a real number. */
	unranked.sort(
		(a, b) =>
			b.completed - a.completed ||
			(b.averagePercent ?? -1) - (a.averagePercent ?? -1) ||
			(unrankedSeconds.get(a.userId) ?? 0) -
				(unrankedSeconds.get(b.userId) ?? 0) ||
			a.name.localeCompare(b.name) ||
			a.userId - b.userId,
	);

	return { rows, unranked };
};
