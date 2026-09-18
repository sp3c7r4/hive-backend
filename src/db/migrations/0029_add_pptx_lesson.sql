ALTER TYPE lesson_type ADD VALUE IF NOT EXISTS 'pptx';
--> statement-breakpoint
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS pptx_url VARCHAR(1000);
