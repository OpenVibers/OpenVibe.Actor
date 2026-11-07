-- phase: expand
-- The one timeline behind the Dock (design 2026-11-07 §2). Expand-only: two new tables, nothing changed, nothing
-- dropped. A row is one step of the agent's work in one mode for one person: its title, its outcome and its link.
-- Never a prompt, a diff or a page: the columns below are the whole shape of an entry (agent.timeline-entry@1).
CREATE TABLE IF NOT EXISTS agent_timeline (
    id               text COLLATE "C" PRIMARY KEY,
    subject          text COLLATE "C" NOT NULL,
    step_id          text COLLATE "C" NOT NULL,
    product          text COLLATE "C" NOT NULL,
    mode             text COLLATE "C" NOT NULL,
    ref              text COLLATE "C",
    title            text COLLATE "C" NOT NULL,
    status           text COLLATE "C" NOT NULL,
    placement_where  text COLLATE "C",
    placement_why    text COLLATE "C",
    cost_usd         numeric,
    link             text COLLATE "C",
    reason           text COLLATE "C",
    transition       text COLLATE "C",
    approval_product text COLLATE "C",
    approval_id      text COLLATE "C",
    approval_kind    text COLLATE "C",
    audience         text COLLATE "C" NOT NULL DEFAULT 'private',
    shared           boolean NOT NULL DEFAULT false,
    started_at       timestamptz NOT NULL,
    ended_at         timestamptz,
    created_at       timestamptz NOT NULL,
    updated_at       timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_timeline_step_idx ON agent_timeline (subject, product, step_id);
CREATE INDEX IF NOT EXISTS agent_timeline_subject_idx ON agent_timeline (subject, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS agent_timeline_status_idx ON agent_timeline (subject, status);

-- The kill switch: whether the person paused the agent. One row per person.
CREATE TABLE IF NOT EXISTS agent_state (
    subject    text COLLATE "C" PRIMARY KEY,
    paused     boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL
);
