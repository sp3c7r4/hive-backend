-- Deletion tombstones: remember WHO deleted a message so history can show
-- "You deleted this message" / "<Name> deleted this message" after reloads.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_by integer REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_messages_deleted_by ON messages(deleted_by) WHERE deleted_by IS NOT NULL;
