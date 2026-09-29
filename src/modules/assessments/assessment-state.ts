/**
 * @info - The attempt policy for an assessment lesson, as pure functions.
 *
 * Nothing is stored as "expired" and nothing runs in the background: the session
 * row records when the attempt started and when (if ever) it was submitted, and
 * the deadline is derived from the lesson's time limit on every read. A state
 * that depends on the clock cannot go stale if it is never persisted, and a
 * student who is mid-attempt when a worker would have run is not a case anyone
 * has to handle.
 *
 * `now` is always a parameter, never `new Date()` in here, so every branch below
 * is testable without freezing anything and the caller decides which clock the
 * request is judged against (the server's).
 */

export type AssessmentStatus =
	| "not_started"
	| "in_progress"
	| "submitted"
	| "expired";

/**
 * @info - How long after the deadline a submit is still accepted. Grace is a
 *         submit rule, not a state: the status flips to `expired` at the
 *         deadline so the UI stops pretending there is time left, but a network
 *         round trip that starts before the bell and lands just after it must
 *         not lose the student's answers.
 */
export const GRACE_SECONDS = 30;

export interface AssessmentSessionTiming {
	startedAt: Date | null;
	submittedAt: Date | null;
}

interface AssessmentTiming {
	session: AssessmentSessionTiming | null;
	timeLimitMinutes: number | null;
	now: Date;
}

/** @info - `null` when the assessment is untimed, or has not been started. */
export const assessmentDeadline = ({
	startedAt,
	timeLimitMinutes,
}: {
	startedAt: Date | null;
	timeLimitMinutes: number | null;
}): Date | null => {
	if (!startedAt || timeLimitMinutes === null) return null;
	return new Date(startedAt.getTime() + timeLimitMinutes * 60_000);
};

/**
 * @info - Spec §3.2. `submitted_at` wins over the clock in both directions: a
 *         student who submitted from inside the window stays submitted after it,
 *         and one who submitted late (inside grace) stays submitted rather than
 *         becoming expired.
 */
export const assessmentState = ({
	session,
	timeLimitMinutes,
	now,
}: AssessmentTiming): AssessmentStatus => {
	if (!session) return "not_started";
	if (session.submittedAt) return "submitted";

	const deadline = assessmentDeadline({
		startedAt: session.startedAt,
		timeLimitMinutes,
	});
	/* @info - No deadline is the untimed case, not "no time left". */
	if (!deadline) return "in_progress";

	return now.getTime() <= deadline.getTime() ? "in_progress" : "expired";
};

/**
 * @info - Whether a submit would still be accepted. True while the attempt is
 *         open, and for GRACE_SECONDS after the deadline; false once submitted
 *         (there is nothing left to send) and false with no session (there is
 *         nothing to send it against).
 */
export const withinGrace = ({
	session,
	timeLimitMinutes,
	now,
}: AssessmentTiming): boolean => {
	if (!session || session.submittedAt) return false;

	const deadline = assessmentDeadline({
		startedAt: session.startedAt,
		timeLimitMinutes,
	});
	if (!deadline) return true;

	return now.getTime() <= deadline.getTime() + GRACE_SECONDS * 1_000;
};
