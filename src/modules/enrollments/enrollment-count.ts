import { type SQL, sql } from "drizzle-orm";
import { enrollments } from "@/modules/enrollments/enrollment.model";
import { payments } from "@/modules/payment/payment.model";

/**
 * @info - How many students a course really has, as one correlated subquery.
 *
 * `courses.enrollment_count` is created at 0 and nothing has ever written to it, so
 * anything reading it reports zero students on a course full of them. This is the
 * single definition of the real count, so the course list, the course detail and the
 * two revenue sums cannot drift apart.
 *
 * Every reference to the outer table is written out in full ("courses"."id") on purpose:
 * a ${column} interpolation renders unqualified here, and an unqualified "id" resolves to the
 * enrolment's own id, which silently counts nothing.
 *
 * Correlated rather than joined: the course list query already joins communities and
 * instructors, and adding an enrollments join with a group by would multiply rows.
 *
 * An enrolment counts when it is not soft-deleted, no payment for it was refunded, and
 * either the course is free, the enrolment was paid for, or someone else created it for
 * the student (staff and parents do this). A paid course with only a pending or failed
 * payment does not count, so unpaid needs no separate rule. There is no "cancelled"
 * state in the schema.
 *
 * See 2026-10-08-counts-locked-curriculum-bulk-invite-design.md, "Which enrollments count".
 */
export const courseEnrollmentCount = (): SQL<number> => sql`
	(select count(*)::int
	   from ${enrollments} e
	  where e.course_id = "courses"."id"
	    and e.deleted_at is null
	    and not exists (
	      select 1 from ${payments} p
	       where p.enrollment_id = e.id
	         and p.status = 'refunded'
	    )
	    and (
	      "courses"."is_free" = true
	      or "courses"."price" = 0
	      or e.enrolled_by_id is not null
	      or exists (
	        select 1 from ${payments} p2
	         where p2.enrollment_id = e.id
	           and p2.status = 'success'
	      )
	    )
	)`;
