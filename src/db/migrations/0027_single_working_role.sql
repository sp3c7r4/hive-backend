-- One working role per person becomes a database invariant.
--
-- selectRole() has always refused a second role in code ("Each user is locked
-- to one role"), but nothing at the database level stopped direct inserts —
-- local QA accounts ended up holding instructor + student + admin by hand,
-- which silently changes what the UI and guards can do (multi-role grants the
-- union of every held role's permissions, so "student can't X" tests pass for
-- the wrong reason).
--
-- Policy: a user holds at most ONE working role (student | instructor | parent).
-- 'admin' is deliberately exempt — platform staff may also teach or study.
--
-- 1. Merge existing extras away, keeping the highest-precedence role:
--    instructor > parent > student, ties break to the lowest id.
--> statement-breakpoint
WITH ranked AS (
	SELECT id,
		row_number() OVER (
			PARTITION BY user_id
			ORDER BY CASE role
				WHEN 'instructor' THEN 1
				WHEN 'parent' THEN 2
				ELSE 3
			END, id
		) AS rn
	FROM user_roles
	WHERE role <> 'admin'
)
DELETE FROM user_roles WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
--> statement-breakpoint
-- 2. Forbid a second working role. Partial: admin rows never participate, so
--    admin + instructor (or admin + student) stays legal.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_role_single_working
	ON user_roles (user_id)
	WHERE role <> 'admin';
