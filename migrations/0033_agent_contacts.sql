-- phase: expand
-- A-1 (plan §12): agents are contacts. A personal agent grows the fields a contact has — a face and a voice, the model
-- it runs on, a computer, connected apps, a Memory scope and an approval level — and exactly one Vibe per person is
-- marked, created lazily on the first read and never deleted. Every task is a thread: it records the agent it runs as
-- and its own level; the effective level is computed from the agent and the person's own parent chain (never another
-- person's work). Expand-only: new columns with defaults, nothing renamed or dropped, so the previous release keeps
-- writing rows.
ALTER TABLE actor_agents
    ADD COLUMN face text NOT NULL DEFAULT 'preset:agent',
    ADD COLUMN voice text,
    ADD COLUMN model_engine text COLLATE "C" NOT NULL DEFAULT 'runtime',
    ADD COLUMN model_id text COLLATE "C" NOT NULL DEFAULT 'smart',
    ADD COLUMN computer jsonb,
    ADD COLUMN apps jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN memory_scope text COLLATE "C",
    ADD COLUMN level text COLLATE "C" NOT NULL DEFAULT 'ask',
    ADD COLUMN is_vibe boolean NOT NULL DEFAULT false,
    ADD COLUMN preset text COLLATE "C";

ALTER TABLE actor_agents
    ADD CONSTRAINT actor_agents_level_check CHECK (level IN ('ask', 'auto-edits', 'approve-for-me', 'full')),
    ADD CONSTRAINT actor_agents_model_engine_check CHECK (model_engine IN ('runtime', 'own-keys', 'open-gpu', 'link'));

-- Vibe, the first agent of every person: at most one.
CREATE UNIQUE INDEX actor_agents_one_vibe ON actor_agents (owner) WHERE is_vibe;

ALTER TABLE tasks
    ADD COLUMN agent_id text COLLATE "C",
    ADD COLUMN level text COLLATE "C" NOT NULL DEFAULT 'ask';

ALTER TABLE tasks
    ADD CONSTRAINT tasks_level_check CHECK (level IN ('ask', 'auto-edits', 'approve-for-me', 'full'));
CREATE INDEX tasks_agent ON tasks (agent_id) WHERE agent_id IS NOT NULL;
