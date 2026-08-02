ALTER TABLE "users" ALTER COLUMN "preferences" SET DEFAULT '{"theme":"system","locale":"en-US","timezone":"UTC","notifications":{"email":true,"sms":false,"whatsapp":false,"push":true}}'::jsonb;--> statement-breakpoint
ALTER TABLE "parent_child_links" ALTER COLUMN "student_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "parent_child_links" ADD COLUMN "linked_email" varchar(255);--> statement-breakpoint
ALTER TABLE "parent_child_links" ADD COLUMN "status" varchar(20) DEFAULT 'active' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_parent_child_email" ON "parent_child_links" USING btree ("linked_email");