import { sql } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import type { IAuthData } from "@/interfaces";

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
				is_admin: boolean;
		  }
		| undefined;

	/* @info - A lesson that is not there is not visible; the caller's 404 is its
	 * own question and is answered where the lesson is read. */
	if (!row) return false;

	if (userId !== null && Number(row.instructor_id) === userId) return true;
	if (row.is_admin === true) return true;

	if (row.course_status !== "published") return false;
	return row.lesson_status === "published";
};
