-- AI course tutor: pgvector extension, chunk store, and exchange log
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS lesson_chunks (
    id SERIAL PRIMARY KEY,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    lesson_type VARCHAR(50) NOT NULL,
    content TEXT NOT NULL,
    embedding VECTOR(384) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lesson_chunks_course ON lesson_chunks (course_id);
CREATE INDEX IF NOT EXISTS idx_lesson_chunks_lesson ON lesson_chunks (lesson_id);
CREATE INDEX IF NOT EXISTS idx_lesson_chunks_embedding
    ON lesson_chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS ai_tutor_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    chunk_ids JSONB NOT NULL DEFAULT '[]',
    answer TEXT,
    guardrail VARCHAR(100),
    used_fallback BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_tutor_logs_user
    ON ai_tutor_logs (user_id, created_at DESC);
