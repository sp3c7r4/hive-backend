-- Live sessions gain a recording (phase 5a of the live-sessions build).
--
-- Before: a live class promised a recording on the learn page and nothing recorded
-- anything. Egress, the bucket, its lifecycle rules and the AWS credentials were all
-- already in place and verified before this phase - no new infrastructure.
--
-- After: one recording per session, stored as columns on the session row itself
-- (D-P5-4: a second table would buy multiple takes nobody can tell apart, and the
-- recording hangs off the session id exactly as the room name does). Every column is
-- nullable, so this migration is safe to apply before the code that reads it, and a
-- session that was never recorded is unchanged.
--
-- `recording_status` is an enum rather than free text for the same reason
-- `live_session_status` is: the five values are the whole state machine, and the
-- column is written only by the recorder. `expired` is deliberately NOT one of them -
-- expiry is derived from the bucket's 90-day lifecycle rule (spec section 4), and a
-- stored flag would drift the moment the rule changes.
--
-- No backfill: rows that existed before this phase were never recorded.
CREATE TYPE live_recording_status AS ENUM ('recording', 'processing', 'ready', 'failed', 'deleted');
--> statement-breakpoint
ALTER TABLE live_sessions
	ADD COLUMN IF NOT EXISTS "recording_status" live_recording_status,
	ADD COLUMN IF NOT EXISTS "recording_egress_id" varchar(255),
	ADD COLUMN IF NOT EXISTS "recording_key" varchar(1000),
	ADD COLUMN IF NOT EXISTS "recording_duration_seconds" integer,
	ADD COLUMN IF NOT EXISTS "recording_started_at" timestamp with time zone,
	ADD COLUMN IF NOT EXISTS "recording_ended_at" timestamp with time zone,
	ADD COLUMN IF NOT EXISTS "recording_error" text;
