-- Instructor signature image for certificates (uploaded in account settings)
ALTER TABLE instructor_profiles ADD COLUMN IF NOT EXISTS signature_url VARCHAR(1000);
