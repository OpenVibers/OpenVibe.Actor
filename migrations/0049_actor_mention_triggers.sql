-- phase: expand
-- HO13: a mention is local to Actor, expires, and may fire once in each conversation.
ALTER TABLE actor_triggers DROP CONSTRAINT IF EXISTS actor_triggers_kind_check;
ALTER TABLE actor_triggers ADD CONSTRAINT actor_triggers_kind_check CHECK (kind IN ('schedule','event','goal','mention'));
ALTER TABLE actor_triggers ADD COLUMN IF NOT EXISTS mention jsonb;
ALTER TABLE actor_triggers ADD COLUMN IF NOT EXISTS fires text COLLATE "C";
ALTER TABLE actor_triggers ADD COLUMN IF NOT EXISTS expires_at bigint;
ALTER TABLE actor_triggers ADD COLUMN IF NOT EXISTS last_fired_in text COLLATE "C";
CREATE INDEX IF NOT EXISTS actor_triggers_mention_active ON actor_triggers (owner, agent_id, expires_at)
    WHERE kind = 'mention' AND state = 'active' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS actor_mention_firings (
    trigger_id text COLLATE "C" NOT NULL REFERENCES actor_triggers(id) ON DELETE CASCADE,
    conversation text COLLATE "C" NOT NULL,
    turn_task_id text COLLATE "C",
    task_id text COLLATE "C",
    fired_at bigint NOT NULL,
    PRIMARY KEY (trigger_id, conversation)
);
