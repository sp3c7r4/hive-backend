import { throwBadRequestError } from "@/helpers/errors/throw-errors";
import { ModuleMessages } from "./course.message";

/* @info - Drip modules keep exactly one UTC instant, so "opens on the 19th" cannot mean two
 * things to two people. Africa/Lagos is UTC+1 all year (Nigeria has no DST), which is why a
 * bare date converts with a constant offset and no timezone library is needed here. */
const LAGOS_OFFSET = "+01:00";
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @info - Turns whatever the API accepted into the instant to store:
 *   `null`                 clears the lock
 *   `undefined`            leaves it alone (the key was absent)
 *   `YYYY-MM-DD`           first thing that morning in Lagos, not in UTC and not in the
 *                          caller's zone, which is the off-by-one-day bug this avoids
 *   a full ISO instant     used exactly as given
 * Anything else is the caller's mistake, and says so as a field error.
 */
export const unlockAtFrom = (
	value: string | null | undefined,
): Date | null | undefined => {
	if (value === undefined) return undefined;
	if (value === null) return null;

	const parsed = new Date(
		BARE_DATE.test(value) ? `${value}T00:00:00${LAGOS_OFFSET}` : value,
	);
	if (Number.isNaN(parsed.getTime())) {
		throwBadRequestError(ModuleMessages.UNLOCK_AT_INVALID);
	}
	return parsed;
};

/**
 * @info - Whether a module is still closed, given its stored instant and the clock. A module
 * with no date is open, an invalid date cannot exist here (it was refused on the way in),
 * and a date exactly now is open, so the boundary favours the student.
 */
export const isModuleLocked = (
	unlockAt: Date | string | null | undefined,
	now: Date = new Date(),
): boolean => {
	if (!unlockAt) return false;
	const opens = unlockAt instanceof Date ? unlockAt : new Date(unlockAt);
	if (Number.isNaN(opens.getTime())) return false;
	return opens.getTime() > now.getTime();
};
