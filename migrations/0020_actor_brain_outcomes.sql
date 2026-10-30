-- phase: expand
-- Actor v2, stage V2-8: what the brain's router has learned. One row per (task kind, tier, step kind, tool) with how
-- often that choice worked and how often it did not. The bandit in server/runtime/brain/choose.js reads it as its
-- prior; server/runtime/brain/learn.js writes it when a task finishes and when a person corrects an answer.
--
-- No person column and no task text: a row is a count, not a record of anyone's task. `task_kind` is the deliverable
-- the understand pass found (answer, file, action, other), `tier` is fast/smart/best, `step_kind` is plan/work/answer/
-- repair, and `tool` is the tool name or '' for a model step. The unique key is what the upsert adds to, so concurrent
-- finishes never lose a count.
--
-- Additive only: a new table, nothing existing is renamed or tightened. An older release that does not know the table
-- ignores it, and its rows carry no user data for account deletion to find.
CREATE TABLE actor_brain_outcomes (
    id text COLLATE "C" PRIMARY KEY,
    task_kind text COLLATE "C" NOT NULL,
    tier text COLLATE "C" NOT NULL,
    step_kind text COLLATE "C" NOT NULL,
    tool text COLLATE "C" NOT NULL DEFAULT '',
    successes integer NOT NULL DEFAULT 0 CHECK (successes >= 0),
    failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
    updated_at text COLLATE "C" NOT NULL,
    UNIQUE (task_kind, tier, step_kind, tool)
);
CREATE INDEX actor_brain_outcomes_lookup ON actor_brain_outcomes (task_kind, step_kind, tier);
