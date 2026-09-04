-- AI grading assist: staging columns, batch registry, per-run audit log
ALTER TABLE assignment_submissions
    ADD COLUMN IF NOT EXISTS ai_suggested_score INTEGER,
    ADD COLUMN IF NOT EXISTS ai_suggested_feedback TEXT,
    ADD COLUMN IF NOT EXISTS ai_suggested_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS ai_grader_run_id INTEGER;

DO $$ BEGIN
    CREATE TYPE grading_batch_status AS ENUM ('running', 'completed', 'completed_with_errors');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS grading_batches (
    id SERIAL PRIMARY KEY,
    lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    created_by INTEGER NOT NULL REFERENCES users(id),
    total_count INTEGER NOT NULL,
    completed_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    status grading_batch_status NOT NULL DEFAULT 'running',
    instructor_context TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_grading_batches_lesson
    ON grading_batches (lesson_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_grading_logs (
    id SERIAL PRIMARY KEY,
    batch_id INTEGER REFERENCES grading_batches(id) ON DELETE SET NULL,
    submission_id INTEGER NOT NULL REFERENCES assignment_submissions(id) ON DELETE CASCADE,
    suggested_score INTEGER,
    suggested_feedback TEXT,
    instructor_context TEXT,
    model VARCHAR(100),
    status VARCHAR(20) NOT NULL DEFAULT 'completed',
    approved_edited VARCHAR(20),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_grading_logs_submission
    ON ai_grading_logs (submission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_grading_logs_batch
    ON ai_grading_logs (batch_id);

ALTER TABLE assignment_submissions
    DROP CONSTRAINT IF EXISTS assignment_submissions_ai_grader_run_fk,
    ADD CONSTRAINT assignment_submissions_ai_grader_run_fk
        FOREIGN KEY (ai_grader_run_id) REFERENCES ai_grading_logs(id) ON DELETE SET NULL;
