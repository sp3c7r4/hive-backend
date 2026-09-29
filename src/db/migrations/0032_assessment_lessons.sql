-- Assessment lessons: a lesson type that can be taken exactly once.
--
-- Before: "quiz" is the only question-bearing lesson, and taking it is stateless -- a submission
-- upserts one quiz_attempts row per (user, question), so a student can resubmit whenever they like
-- and "has this student taken it" is not a question the schema can answer. GET
-- /quiz/attempts/:lessonId returns those same rows, so it cannot express "started but not
-- submitted" either.
--
-- After: an assessment is a quiz-shaped lesson with an attempt policy. The policy lives in its own
-- session row rather than on quiz_attempts because the two have different lifetimes -- an attempt
-- is a fact about a student and a lesson, and a student who started and walked away has one even
-- with zero answers recorded.
--
-- time_limit_minutes is nullable on every lesson type and read only for assessments (an absent
-- value means untimed), so no existing lesson changes behaviour.
--
-- The unique index IS the once-only rule, not a check in application code: two concurrent Start
-- presses must not be able to open two sessions, and only the database can promise that.
--
-- No backfill: no assessment lesson exists yet.
ALTER TYPE lesson_type ADD VALUE IF NOT EXISTS 'assessment';
--> statement-breakpoint
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS "time_limit_minutes" integer
	CONSTRAINT lessons_time_limit_minutes_positive CHECK ("time_limit_minutes" IS NULL OR "time_limit_minutes" > 0);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS assessment_sessions (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"user_id" integer NOT NULL REFERENCES users("id") ON DELETE CASCADE,
	"lesson_id" integer NOT NULL REFERENCES lessons("id") ON DELETE CASCADE,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_assessment_session" ON assessment_sessions ("user_id", "lesson_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_assessment_sessions_lesson" ON assessment_sessions ("lesson_id");
