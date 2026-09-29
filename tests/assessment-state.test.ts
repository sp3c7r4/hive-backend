import { describe, expect, it } from "vitest";
import {
	assessmentDeadline,
	assessmentState,
	GRACE_SECONDS,
	withinGrace,
} from "@/modules/assessments/assessment-state";

/**
 * @info - The state table from spec §3.2, and the one boundary that matters.
 *
 * The server owns the clock: nothing is stored as "expired", so this function is
 * the only place the deadline is interpreted. Every case below is a row of that
 * table plus the deadline second itself, which is where an off-by-one would live
 * — `now <= deadline` is in progress, one second later is expired.
 *
 * Grace is deliberately NOT a state. The status flips to `expired` at the
 * deadline so the UI stops pretending there is time left, while the submit path
 * still accepts a late submit for `GRACE_SECONDS` afterwards; an in-progress-only
 * rule would reject exactly the submits the grace window exists for.
 */

const NOW = new Date("2026-09-29T12:00:00.000Z");
const startedMinutesAgo = (minutes: number) =>
	new Date(NOW.getTime() - minutes * 60_000);
const at = (offsetSeconds: number) =>
	new Date(NOW.getTime() + offsetSeconds * 1_000);

describe("assessmentDeadline", () => {
	it("is null when the assessment is untimed", () => {
		expect(
			assessmentDeadline({
				startedAt: startedMinutesAgo(5),
				timeLimitMinutes: null,
			}),
		).toBeNull();
	});

	it("is started_at plus the limit", () => {
		const startedAt = startedMinutesAgo(5);
		expect(assessmentDeadline({ startedAt, timeLimitMinutes: 30 })).toEqual(
			new Date(startedAt.getTime() + 30 * 60_000),
		);
	});

	it("is null with no session to measure from", () => {
		expect(
			assessmentDeadline({ startedAt: null, timeLimitMinutes: 30 }),
		).toBeNull();
	});
});

describe("assessmentState", () => {
	it("not_started with no session row", () => {
		expect(
			assessmentState({ session: null, timeLimitMinutes: 30, now: NOW }),
		).toBe("not_started");
	});

	it("in_progress, no deadline, when the lesson is untimed", () => {
		expect(
			assessmentState({
				session: { startedAt: startedMinutesAgo(90), submittedAt: null },
				timeLimitMinutes: null,
				now: NOW,
			}),
		).toBe("in_progress");
	});

	it("in_progress before the deadline", () => {
		expect(
			assessmentState({
				session: { startedAt: startedMinutesAgo(5), submittedAt: null },
				timeLimitMinutes: 30,
				now: NOW,
			}),
		).toBe("in_progress");
	});

	it("in_progress AT the deadline second, expired one second later", () => {
		const session = { startedAt: startedMinutesAgo(30), submittedAt: null };
		/* @info - The whole deadline table hinges on this pair. */
		expect(assessmentState({ session, timeLimitMinutes: 30, now: NOW })).toBe(
			"in_progress",
		);
		expect(assessmentState({ session, timeLimitMinutes: 30, now: at(1) })).toBe(
			"expired",
		);
	});

	it("expired long after the deadline", () => {
		expect(
			assessmentState({
				session: { startedAt: startedMinutesAgo(600), submittedAt: null },
				timeLimitMinutes: 30,
				now: NOW,
			}),
		).toBe("expired");
	});

	it("submitted wins over the clock, late or early", () => {
		const submittedAt = startedMinutesAgo(10);
		expect(
			assessmentState({
				session: { startedAt: startedMinutesAgo(10), submittedAt },
				timeLimitMinutes: 30,
				now: NOW,
			}),
		).toBe("submitted");
		expect(
			assessmentState({
				session: { startedAt: startedMinutesAgo(600), submittedAt },
				timeLimitMinutes: 30,
				now: NOW,
			}),
		).toBe("submitted");
	});

	it("submitted on an untimed lesson", () => {
		expect(
			assessmentState({
				session: { startedAt: startedMinutesAgo(10), submittedAt: NOW },
				timeLimitMinutes: null,
				now: NOW,
			}),
		).toBe("submitted");
	});
});

describe("withinGrace", () => {
	it("false with no session, and false once submitted", () => {
		expect(withinGrace({ session: null, timeLimitMinutes: 30, now: NOW })).toBe(
			false,
		);
		expect(
			withinGrace({
				session: { startedAt: startedMinutesAgo(31), submittedAt: NOW },
				timeLimitMinutes: 30,
				now: NOW,
			}),
		).toBe(false);
	});

	it("true while in progress, and true for the whole grace window past the deadline", () => {
		const expiredOneSecondAgo = {
			startedAt: startedMinutesAgo(30),
			submittedAt: null,
		};
		expect(
			withinGrace({
				session: { startedAt: startedMinutesAgo(5), submittedAt: null },
				timeLimitMinutes: 30,
				now: NOW,
			}),
		).toBe(true);
		expect(
			withinGrace({
				session: expiredOneSecondAgo,
				timeLimitMinutes: 30,
				now: at(1),
			}),
		).toBe(true);
		expect(
			withinGrace({
				session: expiredOneSecondAgo,
				timeLimitMinutes: 30,
				now: at(GRACE_SECONDS),
			}),
		).toBe(true);
		expect(
			withinGrace({
				session: expiredOneSecondAgo,
				timeLimitMinutes: 30,
				now: at(GRACE_SECONDS + 1),
			}),
		).toBe(false);
	});

	it("true for an untimed lesson: nothing to be late for", () => {
		expect(
			withinGrace({
				session: { startedAt: startedMinutesAgo(600), submittedAt: null },
				timeLimitMinutes: null,
				now: NOW,
			}),
		).toBe(true);
	});
});
