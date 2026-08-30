-- @info - M0 checkout: community payment type + payments.courseId
-- (payments previously could not record a community purchase, and the
--  checkout flow needs a course reference before an enrollment exists)
ALTER TYPE "payment_type" ADD VALUE IF NOT EXISTS 'community';--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "course_id" integer REFERENCES "courses"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payments_course" ON "payments" ("course_id");
