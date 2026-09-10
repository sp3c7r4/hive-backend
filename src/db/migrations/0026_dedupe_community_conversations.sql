-- One group chat per community becomes a database invariant.
--
-- ensureCommunityConversation was SELECT-then-INSERT with no constraint, so two
-- concurrent GET /messages/conversations calls (React StrictMode double-mounts
-- the messages page, which fires the list twice) each inserted a group row for
-- the same community. Local dev showed pairs 86us / 449us apart.
--
-- Merge the duplicates first, then forbid them. Survivor rule: the conversation
-- with the most messages wins, ties break to the lowest id, so the row the UI
-- has been using (and any messages in it) survives. Every statement is
-- idempotent: on a clean database they all no-op.

-- 1. Re-point messages to the surviving conversation.
WITH ranked AS (
	SELECT c.id,
		first_value(c.id) OVER (
			PARTITION BY c.community_id
			ORDER BY (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) DESC, c.id
		) AS keep_id
	FROM conversations c
	WHERE c.type = 'group' AND c.community_id IS NOT NULL
),
dupes AS (
	SELECT id, keep_id FROM ranked WHERE id <> keep_id
)
UPDATE messages SET conversation_id = d.keep_id
FROM dupes d
WHERE messages.conversation_id = d.id;
--> statement-breakpoint
-- 2. Re-point participants — union of both sets. A user already on the survivor
--    keeps their own row, and with it their left_at / last_read_at.
WITH ranked AS (
	SELECT c.id,
		first_value(c.id) OVER (
			PARTITION BY c.community_id
			ORDER BY (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) DESC, c.id
		) AS keep_id
	FROM conversations c
	WHERE c.type = 'group' AND c.community_id IS NOT NULL
),
dupes AS (
	SELECT id, keep_id FROM ranked WHERE id <> keep_id
)
INSERT INTO conversation_participants (conversation_id, user_id, role, joined_at, left_at, last_read_at)
SELECT d.keep_id, p.user_id, p.role, p.joined_at, p.left_at, p.last_read_at
FROM conversation_participants p
JOIN dupes d ON d.id = p.conversation_id
ON CONFLICT (conversation_id, user_id) DO NOTHING;
--> statement-breakpoint
-- 3. Refresh the survivor's list ordering: messages may have moved onto it.
WITH ranked AS (
	SELECT c.id,
		first_value(c.id) OVER (
			PARTITION BY c.community_id
			ORDER BY (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) DESC, c.id
		) AS keep_id
	FROM conversations c
	WHERE c.type = 'group' AND c.community_id IS NOT NULL
),
dupes AS (
	SELECT id, keep_id FROM ranked WHERE id <> keep_id
),
survivors AS (
	SELECT DISTINCT keep_id FROM dupes
)
UPDATE conversations c
SET last_message_at = (
	SELECT max(m.created_at) FROM messages m WHERE m.conversation_id = c.id
)
WHERE c.id IN (SELECT keep_id FROM survivors);
--> statement-breakpoint
-- 4. Drop the duplicates — participants and messages already belong to the survivor.
WITH ranked AS (
	SELECT c.id,
		first_value(c.id) OVER (
			PARTITION BY c.community_id
			ORDER BY (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) DESC, c.id
		) AS keep_id
	FROM conversations c
	WHERE c.type = 'group' AND c.community_id IS NOT NULL
),
dupes AS (
	SELECT id, keep_id FROM ranked WHERE id <> keep_id
)
DELETE FROM conversations WHERE id IN (SELECT id FROM dupes);
--> statement-breakpoint
-- 5. The invariant: at most one group conversation per community. Partial index
--    so direct threads (community_id NULL) are unaffected. ensureCommunityConversation
--    inserts with ON CONFLICT DO NOTHING against this index, which is what makes
--    concurrent callers collapse into one row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_community_group
	ON conversations (community_id)
	WHERE type = 'group' AND community_id IS NOT NULL;
