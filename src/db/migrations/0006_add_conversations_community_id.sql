ALTER TABLE "conversations" ADD COLUMN "community_id" integer;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_conversations_community" ON "conversations" ("community_id");--> statement-breakpoint
