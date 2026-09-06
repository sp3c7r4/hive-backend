--> statement-breakpoint
CREATE TYPE "lesson_meeting_type" AS ENUM('none','native','external');
--> statement-breakpoint
CREATE TYPE "lesson_live_status" AS ENUM('scheduled','live','ended');
--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "meeting_type" "lesson_meeting_type" NOT NULL DEFAULT 'none';
--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "meeting_url" text;
--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "scheduled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "live_status" "lesson_live_status" NOT NULL DEFAULT 'scheduled';
--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "duration_minutes" integer NOT NULL DEFAULT 60;
--> statement-breakpoint
-- @info - Backfill from the legacy live fields (spec 19 transition):
-- meeting_url copies live_meeting_link; scheduled_at parses the legacy
-- 'YYYY-MM-DDTHH:mm' string as Africa/Lagos (the platform's cohort zone).
--> statement-breakpoint
UPDATE "lessons" SET "meeting_url" = "live_meeting_link" WHERE "live_meeting_link" IS NOT NULL;
--> statement-breakpoint
UPDATE "lessons" SET "meeting_type" = 'external' WHERE "live_meeting_link" IS NOT NULL;
--> statement-breakpoint
UPDATE "lessons"
SET "scheduled_at" = to_timestamp("live_meeting_date", 'YYYY-MM-DD"T"HH24:MI') AT TIME ZONE 'Africa/Lagos'
WHERE "live_meeting_date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}';
--> statement-breakpoint
CREATE INDEX "idx_lessons_scheduled_at" ON "lessons" ("scheduled_at");
