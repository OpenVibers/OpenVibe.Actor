-- phase: expand
-- Triggers made in a conversation (plan §12 A-4): the routine's schedule (or its Watch event source), the
-- agent it runs, the card's last result and failure streak, and the ten-minute undo window. The Watch
-- subscription is the runner; this table is Actor's card and ownership record.
CREATE TABLE IF NOT EXISTS actor_triggers (
    id            text COLLATE "C" PRIMARY KEY,
    owner         text COLLATE "C" NOT NULL,
    agent_id      text COLLATE "C" NOT NULL,
    task          text COLLATE "C" NOT NULL,
    kind          text COLLATE "C" NOT NULL CHECK (kind IN ('schedule','event')),
    schedule      jsonb,
    event         jsonb,
    timezone      text COLLATE "C",
    words         text COLLATE "C" NOT NULL,
    level         text COLLATE "C" NOT NULL DEFAULT 'ask',
    state         text COLLATE "C" NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused','deleted')),
    paused_reason text COLLATE "C",
    failures      bigint NOT NULL DEFAULT 0,
    watch_id      text COLLATE "C",
    turn_task_id  text COLLATE "C",
    last_task_id  text COLLATE "C",
    last_state    text COLLATE "C",
    last_run_at   bigint,
    created_at    bigint NOT NULL,
    updated_at    bigint NOT NULL,
    deleted_at    bigint
);
CREATE INDEX IF NOT EXISTS actor_triggers_owner ON actor_triggers (owner, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS actor_triggers_watch ON actor_triggers (watch_id) WHERE watch_id IS NOT NULL;

-- One trigger run per task. The engine updates this row as the task moves; a terminal result writes the
-- trigger's last run and its consecutive-failure streak.
CREATE TABLE IF NOT EXISTS actor_trigger_runs (
    trigger_id text COLLATE "C" NOT NULL REFERENCES actor_triggers(id) ON DELETE CASCADE,
    task_id    text COLLATE "C" PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    state      text COLLATE "C" NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS actor_trigger_runs_trigger ON actor_trigger_runs (trigger_id, created_at DESC);
