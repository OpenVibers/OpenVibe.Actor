-- phase: expand
-- HO5 (plan track HO, wave 2): an agent's memory that consolidates itself.
--
-- Nothing here changes what memory already is: the same table, the same rules (only the person's own words make an
-- active memory; a secret is never stored). Four additions, all of them new:
--
--   actor_agent_memory gets four columns and loses nothing:
--     merged_into  the id of the note that replaced this one: a merge keeps its sources, marked;
--     retired_at   when the night's tidy retired this note (stale, or contradicted by a newer one): never deleted;
--     pinned       the agent reads a pinned note first;
--     pinned_by    who pinned it: 'person' (by hand) or 'agent' (by the night's tidy). The tidy never touches a
--                  note the person wrote (origin 'person') or pinned by hand.
--
--   actor_memory_tidy is the person's consent and the date of their next night: one row per person, off by default,
--     next_due_at says when the job may pick it up. The job is due-based (a row per person), never a weekly interval
--     in the code.
--
--   actor_memory_tidy_runs is the night's history: one row per agent per night, with the diary, what changed and what
--     the call cost.
--
--   actor_memory_changes is one row per applied change, with the state it replaced, so the person can undo it for
--     30 days.
--
--   actor_memory_diary is the diary entry itself, which the person may edit or delete.
--
-- Expand-only: new columns with defaults, new tables, nothing renamed, nothing dropped. The previous release keeps
-- working: it never writes these columns, and its rows keep their meaning (a note with no merged_into and no
-- retired_at is exactly the note it always was).

ALTER TABLE actor_agent_memory
    ADD COLUMN merged_into text COLLATE "C",
    ADD COLUMN retired_at text COLLATE "C",
    ADD COLUMN pinned boolean NOT NULL DEFAULT false,
    ADD COLUMN pinned_by text COLLATE "C";

ALTER TABLE actor_agent_memory
    ADD CONSTRAINT actor_agent_memory_pinned_by_check CHECK (pinned_by IS NULL OR pinned_by IN ('person', 'agent'));

CREATE INDEX actor_agent_memory_tidy ON actor_agent_memory (agent_id, created_order DESC)
    WHERE retired_at IS NULL AND merged_into IS NULL;

-- The person's consent and the date of their next night. Off until they turn it on.
CREATE TABLE actor_memory_tidy (
    owner text COLLATE "C" PRIMARY KEY,
    enabled boolean NOT NULL DEFAULT false,
    next_due_at text COLLATE "C",
    last_run_at text COLLATE "C",
    last_error text COLLATE "C",
    created_at text COLLATE "C" NOT NULL,
    updated_at text COLLATE "C" NOT NULL
);
CREATE INDEX actor_memory_tidy_due ON actor_memory_tidy (next_due_at) WHERE enabled;

-- What one agent's night did: the diary it wrote, the changes it made and what the call cost.
CREATE TABLE actor_memory_tidy_runs (
    id text COLLATE "C" PRIMARY KEY,
    owner text COLLATE "C" NOT NULL,
    agent_id text COLLATE "C" NOT NULL REFERENCES actor_agents (id) ON DELETE CASCADE,
    night_of text COLLATE "C" NOT NULL,
    diary text COLLATE "C",
    changes jsonb NOT NULL DEFAULT '[]'::jsonb,
    model text COLLATE "C",
    latency_class text COLLATE "C",
    cost_usd double precision NOT NULL DEFAULT 0,
    created_at text COLLATE "C" NOT NULL
);
CREATE INDEX actor_memory_tidy_runs_owner ON actor_memory_tidy_runs (owner, created_at DESC);

-- One applied change, with the state it replaced: the person's undo for thirty days.
CREATE TABLE actor_memory_changes (
    id text COLLATE "C" PRIMARY KEY,
    owner text COLLATE "C" NOT NULL,
    agent_id text COLLATE "C" NOT NULL REFERENCES actor_agents (id) ON DELETE CASCADE,
    tidy_run_id text COLLATE "C" REFERENCES actor_memory_tidy_runs (id) ON DELETE SET NULL,
    kind text COLLATE "C" NOT NULL CHECK (kind IN ('merge', 'retire', 'promote')),
    note_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    result_id text COLLATE "C",
    detail text COLLATE "C",
    before_state jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at text COLLATE "C" NOT NULL,
    undone_at text COLLATE "C"
);
CREATE INDEX actor_memory_changes_owner ON actor_memory_changes (owner, created_at DESC);

-- The diary entry, in the agent's voice. The person may edit it or delete it.
CREATE TABLE actor_memory_diary (
    id text COLLATE "C" PRIMARY KEY,
    owner text COLLATE "C" NOT NULL,
    agent_id text COLLATE "C" NOT NULL REFERENCES actor_agents (id) ON DELETE CASCADE,
    text text COLLATE "C" NOT NULL CHECK (char_length(text) BETWEEN 1 AND 2000),
    created_at text COLLATE "C" NOT NULL,
    edited_at text COLLATE "C",
    deleted_at text COLLATE "C"
);
CREATE INDEX actor_memory_diary_owner ON actor_memory_diary (owner, created_at DESC);
