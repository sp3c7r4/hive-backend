/**
 * @info - Certificate eligibility, as a pure decision over plain data.
 *
 * This is the single source of truth for "has this student earned a
 * certificate". It takes no database handle, no service and no clock, so every
 * rule below is exhaustively testable and the same rules can be reused to
 * explain the decision to a student, an instructor or an admin.
 *
 * Before this existed the rules lived as silent early `return`s inside the
 * enrollment service: a student at 100% completion could be refused a
 * certificate with nothing to explain it, and an unattempted quiz was reported
 * as a fabricated 0% score.
 */

export type CertificateQuizState = "passed" | "failed" | "not_attempted";

export interface CertificateQuizInput {
	lessonId: number;
	title: string;
	/** Questions authored on the quiz lesson — the score denominator. */
	totalQuestions: number;
	/** Questions the student has currently answered correctly. */
	correctAnswers: number;
	/** True when the student has submitted at least one question. */
	attempted: boolean;
}

export interface CertificateEligibilityInput {
	offerCertificate: boolean;
	minCompletionPercent: number;
	minQuizScorePercent: number;
	/** Non-draft lessons of the course. */
	publishedLessonIds: number[];
	/** Lesson ids with a completed progress row. */
	completedLessonIds: number[];
	/** Quiz lessons of the course, already filtered to published ones. */
	quizLessons: CertificateQuizInput[];
}

export interface CertificateRequirement {
	kind: "completion" | "quiz";
	met: boolean;
	/** The measured value, or null when there is nothing to measure. */
	actual: number | null;
	required: number;
	quizLessonId?: number;
	quizTitle?: string;
	state?: CertificateQuizState;
}

export interface CertificateEligibilityResult {
	eligible: boolean;
	completionPercent: number;
	/** Lowest individual quiz score, or null when quizzes are not a requirement. */
	quizScorePercent: number | null;
	/** Every requirement, met or not — never a silent failure. */
	requirements: CertificateRequirement[];
	/** Human-readable summary, present only when not eligible. */
	reason?: string;
}

const percent = (part: number, whole: number): number =>
	whole > 0 ? Math.round((part / whole) * 100) : 0;

export function evaluateCertificateEligibility(
	input: CertificateEligibilityInput,
): CertificateEligibilityResult {
	const {
		offerCertificate,
		minCompletionPercent,
		minQuizScorePercent,
		publishedLessonIds,
		completedLessonIds,
		quizLessons,
	} = input;

	/* @info - Only published lessons count, in both directions: a draft lesson
	 * cannot be required, and a completion recorded against one cannot inflate
	 * the numerator. */
	const completed = new Set(completedLessonIds);
	const donePublished = publishedLessonIds.filter((id) =>
		completed.has(id),
	).length;
	const completionPercent = percent(donePublished, publishedLessonIds.length);

	const empty: CertificateEligibilityResult = {
		eligible: false,
		completionPercent,
		quizScorePercent: null,
		requirements: [],
	};

	if (!offerCertificate) {
		return { ...empty, reason: "This course does not offer certificates." };
	}

	if (publishedLessonIds.length === 0) {
		return {
			...empty,
			completionPercent: 0,
			reason: "This course has no published lessons.",
		};
	}

	const requirements: CertificateRequirement[] = [
		{
			kind: "completion",
			met: completionPercent >= minCompletionPercent,
			actual: completionPercent,
			required: minCompletionPercent,
		},
	];

	/* @info - A threshold of 0 means quizzes are not a requirement at all — the
	 * completion gate alone decides, which is what keeps reading-only and
	 * video-only courses certifiable. */
	const quizzesRequired = minQuizScorePercent > 0;
	const scorableQuizzes = quizzesRequired
		? quizLessons.filter((quiz) => quiz.totalQuestions > 0)
		: [];

	/* @info - A quiz lesson with no authored questions is skipped rather than
	 * required: it can never be attempted, so counting it would make the
	 * certificate permanently unreachable. */
	const attemptedScores: number[] = [];

	for (const quiz of scorableQuizzes) {
		const score = percent(quiz.correctAnswers, quiz.totalQuestions);
		const state: CertificateQuizState = !quiz.attempted
			? "not_attempted"
			: score >= minQuizScorePercent
				? "passed"
				: "failed";

		if (quiz.attempted) attemptedScores.push(score);

		requirements.push({
			kind: "quiz",
			met: state === "passed",
			actual: quiz.attempted ? score : null,
			required: minQuizScorePercent,
			quizLessonId: quiz.lessonId,
			quizTitle: quiz.title,
			state,
		});
	}

	const eligible = requirements.every((requirement) => requirement.met);

	return {
		eligible,
		completionPercent,
		quizScorePercent: attemptedScores.length
			? Math.min(...attemptedScores)
			: null,
		requirements,
		...(eligible ? {} : { reason: _explain(requirements) }),
	};
}

/** @info - Names every unmet requirement, so the UI never has to guess. */
function _explain(requirements: CertificateRequirement[]): string {
	const unmet = requirements.filter((requirement) => !requirement.met);

	return unmet
		.map((requirement) => {
			if (requirement.kind === "completion") {
				return `Finish ${requirement.required}% of the published lessons — you are at ${requirement.actual}%.`;
			}
			if (requirement.state === "not_attempted") {
				return `"${requirement.quizTitle}" has not been attempted.`;
			}
			return `"${requirement.quizTitle}" scored ${requirement.actual}% — ${requirement.required}% is required.`;
		})
		.join(" ");
}
