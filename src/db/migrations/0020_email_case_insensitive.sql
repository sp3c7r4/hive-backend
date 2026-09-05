-- 0020: case-insensitive email uniqueness
-- @info - Signup/login/forgot-password/OAuth now normalize emails to
-- lowercase in code. This migration normalizes existing rows and swaps
-- the case-sensitive unique index for a lower(email) index so the DB
-- enforces the rule even if a future code path forgets.

-- 1) Case-variant duplicates: keep the oldest account (lowest id); newer
--    rows keep their data but their email becomes an alias
--    (local+dup<id>@domain, same mailbox via plus-addressing) so the
--    case-insensitive index can be created. Prod had one group on
--    2026-09-05: eyiowuawi.timileyin@gmail.com (ids 8, 11 - id 11 kept
--    under the alias, never logged in).
WITH ranked AS (
	SELECT
		id,
		row_number() OVER (PARTITION BY lower(email) ORDER BY id) AS rn
	FROM users
)
UPDATE users u
SET email = split_part(lower(u.email), '@', 1) || '+dup' || u.id || '@' || split_part(lower(u.email), '@', 2)
FROM ranked r
WHERE u.id = r.id
	AND r.rn > 1
	AND lower(u.email) IN (
		SELECT lower(email) FROM users GROUP BY lower(email) HAVING count(*) > 1
	)
--> statement-breakpoint
-- 2) Normalize the rest to lowercase
UPDATE users
SET email = lower(email)
WHERE email <> lower(email)
--> statement-breakpoint
-- 3) Case-insensitive unique index replaces the case-sensitive one
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_lower ON users (lower(email))
--> statement-breakpoint
DROP INDEX IF EXISTS uq_users_email
