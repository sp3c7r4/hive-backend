-- Live sessions become the unit of a live class (phase 1 of the live-sessions build).
--
-- Before: live-ness was a set of columns on a lesson (meeting_type, meeting_url,
-- scheduled_at, live_status, duration_minutes) plus two dead legacy columns
-- (live_meeting_link, live_meeting_date) that the course player still read for
-- external meetings while the calendar read meeting_url. A community event that is
-- not a lesson could not exist, identity was re-derived from a lesson everywhere,
-- and the two external-URL paths disagreed.
--
-- After: one live_sessions row per scheduled live thing. A live lesson points at
-- its session through lessons.live_session_id, a standalone event is a session with
-- no lesson, and native vs external is the session's kind.
--
-- This migration is destructive: it drops the seven lesson columns and the two
-- lesson live enums, so it must run together with the code that stopped using them
-- (backend and frontend ship in the same window, backend first).
--
-- The backfill correlates sessions to lessons by carrying the source lesson id
-- through the insert. It deliberately does NOT match on (course, title, starts_at):
-- two lessons can share a title at the same or at both-null times, and UPDATE ...
-- FROM picks between candidates nondeterministically, so a swapped pair would
-- satisfy the unique index while attaching the wrong meeting_url and description to
-- a lesson.
--
-- Note: lessons has no deleted_at (soft-delete exists only on courses and
-- communities, and the lesson repository hard-deletes), so the backfill has nothing
-- to filter there.
--
-- 1. the session table
CREATE TYPE live_session_kind AS ENUM ('native', 'external');
--> statement-breakpoint
CREATE TYPE live_session_status AS ENUM ('scheduled', 'live', 'ended', 'cancelled');
--> statement-breakpoint
CREATE TABLE live_sessions (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"kind" live_session_kind NOT NULL,
	"community_id" integer NOT NULL REFERENCES communities("id") ON DELETE CASCADE,
	"course_id" integer REFERENCES courses("id") ON DELETE CASCADE,
	"host_id" integer NOT NULL REFERENCES users("id") ON DELETE RESTRICT,
	"title" varchar(255) NOT NULL,
	"description" text,
	"meeting_url" varchar(1000),
	"starts_at" timestamp with time zone,
	"duration_minutes" integer DEFAULT 60 NOT NULL,
	"status" live_session_status DEFAULT 'scheduled' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "idx_live_sessions_community_starts" ON live_sessions ("community_id", "starts_at");
--> statement-breakpoint
CREATE INDEX "idx_live_sessions_host_starts" ON live_sessions ("host_id", "starts_at");
--> statement-breakpoint
CREATE INDEX "idx_live_sessions_course" ON live_sessions ("course_id");
--> statement-breakpoint
-- 2. the lesson link, one session per lesson (partial so non-meeting lessons stay free)
ALTER TABLE lessons ADD COLUMN "live_session_id" integer;
--> statement-breakpoint
ALTER TABLE lessons ADD CONSTRAINT "lessons_live_session_id_live_sessions_id_fk"
	FOREIGN KEY ("live_session_id") REFERENCES live_sessions("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_lessons_live_session" ON lessons ("live_session_id")
	WHERE "live_session_id" IS NOT NULL;
--> statement-breakpoint
-- 3. backfill, correlated by source lesson id
ALTER TABLE live_sessions ADD COLUMN IF NOT EXISTS "_src_lesson_id" integer;
--> statement-breakpoint
INSERT INTO live_sessions (kind, community_id, course_id, host_id, title, description, meeting_url, starts_at, duration_minutes, status, _src_lesson_id)
SELECT l.meeting_type::text::live_session_kind,
       c.community_id,
       c.id,
       c.instructor_id,
       l.title,
       l.description,
       -- the player read live_meeting_link and the calendar read meeting_url, so a
       -- lesson can carry the external URL in either column
       COALESCE(l.meeting_url, l.live_meeting_link),
       l.scheduled_at,
       COALESCE(l.duration_minutes, 60),
       CASE l.live_status
         WHEN 'live' THEN 'live'::live_session_status
         WHEN 'ended' THEN 'ended'::live_session_status
         ELSE 'scheduled'::live_session_status
       END,
       l.id
FROM lessons l
JOIN modules m ON m.id = l.module_id
JOIN courses c ON c.id = m.course_id
WHERE l.meeting_type <> 'none'
  AND l.live_session_id IS NULL;
--> statement-breakpoint
UPDATE lessons l
SET live_session_id = s.id
FROM live_sessions s
WHERE s._src_lesson_id = l.id
  AND l.live_session_id IS NULL;
--> statement-breakpoint
ALTER TABLE live_sessions DROP COLUMN IF EXISTS "_src_lesson_id";
--> statement-breakpoint
-- 4. drop the old model
ALTER TABLE lessons
	DROP COLUMN "live_meeting_link",
	DROP COLUMN "live_meeting_date",
	DROP COLUMN "meeting_type",
	DROP COLUMN "meeting_url",
	DROP COLUMN "scheduled_at",
	DROP COLUMN "live_status",
	DROP COLUMN "duration_minutes";
--> statement-breakpoint
DROP TYPE lesson_meeting_type;
--> statement-breakpoint
DROP TYPE lesson_live_status;
