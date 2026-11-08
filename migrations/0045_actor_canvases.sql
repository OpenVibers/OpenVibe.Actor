-- phase: expand
-- HO9 (plan track HO, wave 2): an agent's live panel beside the conversation.
--
-- A canvas is the data document actor.canvas@1 (Contracts v0.340.0, ADR-059) drawn by OpenVibe.Shared's
-- ov-canvas.js. One row is one person's canvas for one thread (the first turn of a conversation, tsk_…): the
-- agent's canvas_set replaces the whole document and the version only grows. NOTICES holds the person's ticks
-- that the next turn has to be told about (a tick is not a new turn: the next run reads it as context and the
-- row is cleared when it does).
--
-- Expand-only: a new table, nothing else changed. A release before HO9 never reads or writes it.
CREATE TABLE actor_canvases (
    id text COLLATE "C" PRIMARY KEY,
    owner text COLLATE "C" NOT NULL,
    agent_id text COLLATE "C",
    thread text COLLATE "C" NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    document jsonb NOT NULL,
    version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    notices jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_at text COLLATE "C" NOT NULL,
    UNIQUE (thread)
);

-- One person's canvases, newest first (the read behind /api/v1/me/canvases and the account export).
CREATE INDEX actor_canvases_owner ON actor_canvases (owner, updated_at DESC);
