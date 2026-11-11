-- phase: expand
-- Materialized AG-UI events keep stable counters, titles and full redacted results across reconnects/restarts.
CREATE TABLE agent_ui_runs (
    id text PRIMARY KEY,
    task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    state jsonb NOT NULL
);
CREATE TABLE agent_ui_events (
    run_id text NOT NULL REFERENCES agent_ui_runs(id) ON DELETE CASCADE,
    seq bigint NOT NULL,
    body jsonb NOT NULL,
    PRIMARY KEY (run_id, seq)
);

ALTER TABLE task_events ADD COLUMN ui_detail jsonb;
