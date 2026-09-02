ALTER TYPE lesson_type ADD VALUE 'google_drive';

ALTER TABLE lessons ADD COLUMN IF NOT EXISTS drive_url VARCHAR(1000);
