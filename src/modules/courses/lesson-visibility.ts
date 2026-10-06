import { sql } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import { throwForbiddenError } from "@/helpers/errors/throw-errors";
import type { IAuthData } from "@/interfaces";
import { LessonMessages } from "./course.message";
import { isModuleLocked } from "./module-unlock";

/**
 * @info - Whether this caller may read this lesson's content.
 *
 * The collection rule lives in `CourseService.listLessons`, which filters
 * unpublished rows out of a module's lesson list. That is only half the job: a
 * lesson is also reachable one at a time — a student can mark it complete, take
 * its quiz, autosave an answer, start its assessment — and every one of those
 * calls names the lesson by id, so hiding it from a list protects nothing.
 *
 * The rule, in one place:
 *
 *   - the course's owner and admins see everything, including drafts, because the
 *     curriculum builder and the viewer's own preview need them;
 *   - a module whose `unlock_at` is still in the future is closed to everyone else,
 *     whether the lesson inside it is published or not (drip);
 *   - everyone else sees a published lesson of a published course, and nothing of a
 *     draft or archived course.
 *
 * It answers only that. Enrolment is a separate question, and the callers that care
 * about it still ask (`assertEnrolledInLesson`, `assertOwnedEnrollment`) — folding
 * it in here would quietly tighten endpoints that were never in scope.
 *
 * Deliberately a free function over raw SQL: the three services that need it
 * (enrollments, assessments, courses) sit in different modules, and importing a
 * model from one into another is how the existing import cycles started.
 */
export const isLessonVisibleTo = async (
	authData: IAuthData | undefined,
	lessonId: number,
): Promise<boolean> => {
	const userId = authData?.id ? Number(authData.id) : null;

	const result = await getDb().execute(sql`
		SELECT
			l.status AS lesson_status,
			c.status AS course_status,
			c.instructor_id,
			m.unlock_at AS module_unlock_at,
			EXISTS (
				SELECT 1 FROM user_roles ur
				WHERE ur.user_id = ${userId} AND ur.role = 'admin'
			) AS is_admin
		FROM lessons l
		JOIN modules m ON m.id = l.module_id
		JOIN courses c ON c.id = m.course_id
		WHERE l.id = ${lessonId} AND c.deleted_at IS NULL
		LIMIT 1
	`);

	const row = result.rows[0] as
		| {
				lesson_status: string;
				course_status: string;
				instructor_id: number;
				module_unlock_at: string | Date | null;
				is_admin: boolean;
		  }
		| undefined;

	/* @info - A lesson that is not there is not visible; the caller's 404 is its
	 * own question and is answered where the lesson is read. */
	if (!row) return false;

	if (userId !== null && Number(row.instructor_id) === userId) return true;
	if (row.is_admin === true) return true;

	/* @info - Drip: a module that has not opened hides its lessons, quizzes and
	 * assessments from students. The owner and the admin answered above, so the
	 * curriculum builder and a preview are never locked out of their own course. */
	if (isModuleLocked(row.module_unlock_at)) return false;

	if (row.course_status !== "published") return false;
	return row.lesson_status === "published";
};

/**
 * @info - The same rule, but it says which one refused.
 *
 * Callers that refuse a lesson used to answer "not published yet" for every refusal,
 * which is wrong and confusing once a module can also be closed on a date. The
 * boolean check runs first (so a test double can keep replacing it), and the reason
 * is only looked up on the refusal path, where one extra query costs nothing.
 */
export const assertLessonVisibleTo = async (
	authData: IAuthData | undefined,
	lessonId: number,
	check: (
		authData: IAuthData | undefined,
		lessonId: number,
	) => Promise<boolean> = isLessonVisibleTo,
): Promise<void> => {
	if (await check(authData, lessonId)) return;

	throwForbiddenError(
		(await isModuleLockedFor(lessonId))
			? LessonMessages.MODULE_NOT_OPEN
			: LessonMessages.NOT_PUBLISHED,
	);
};

/** @info - Just the module's date, for the refusal message. No rows means no lock. */
const isModuleLockedFor = async (lessonId: number): Promise<boolean> => {
	const result = await getDb().execute(sql`
		SELECT m.unlock_at AS module_unlock_at
		FROM lessons l
		JOIN modules m ON m.id = l.module_id
		WHERE l.id = ${lessonId}
		LIMIT 1
	`);
	const row = result.rows[0] as
		| { module_unlock_at: string | Date | null }
		| undefined;
	return isModuleLocked(row?.module_unlock_at);
};
