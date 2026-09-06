-- Voice messages: new message_type value + audio duration metadata
DO $$
BEGIN
	ALTER TYPE message_type ADD VALUE IF NOT EXISTS 'audio';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS duration_ms integer;
