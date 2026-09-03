-- AI course builder: append-only audit log for live draft generations
CREATE TABLE IF NOT EXISTS ai_course_builder_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mode VARCHAR(20) NOT NULL,
    syllabus TEXT,
    result_summary TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'completed',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_course_builder_logs_user
    ON ai_course_builder_logs (user_id, created_at DESC);
