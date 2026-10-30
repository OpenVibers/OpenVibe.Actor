-- phase: expand
-- Actor v2, stage V2-10: one row per model call, tool call, check, judgement and sub-agent hand-off, with what the call
-- cost. The task page's Trace fold reads them, and server/runtime/stats.js aggregates them for the brain's step choice.
--
-- Privacy: a span is numbers and names only. No prompt, tool input, tool output or user text is ever written here.
--   name       the model id or the tool name (an identifier the code already holds)
--   error_code a short code (actor.tool.failed), never an error message that could quote a person's text
-- The rows go with their task (ON DELETE CASCADE) and are exported with the person's tasks
-- (server/identity/account-data.js), so deletion removes them.
--
-- parent_id is the delegate span a sub-agent's model and tool spans hang under. It is deliberately not a foreign key:
-- a child's spans are written while the delegate call is still running, before the parent's own row (with its final
-- ms and cost) can be written. Both rows share the same task and go with it.
CREATE TABLE actor_spans (
    id text COLLATE "C" PRIMARY KEY,
    task_id text COLLATE "C" NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    parent_id text COLLATE "C",
    kind text COLLATE "C" NOT NULL CHECK (kind IN ('model', 'tool', 'check', 'judge', 'delegate')),
    name text COLLATE "C" NOT NULL,
    tier text COLLATE "C",
    family text COLLATE "C",
    started_at text COLLATE "C" NOT NULL,
    ms integer NOT NULL DEFAULT 0 CHECK (ms >= 0),
    cost_usd numeric(14, 8) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
    tokens_in integer CHECK (tokens_in IS NULL OR tokens_in >= 0),
    tokens_out integer CHECK (tokens_out IS NULL OR tokens_out >= 0),
    ok boolean NOT NULL DEFAULT true,
    error_code text COLLATE "C",
    step integer
);
CREATE INDEX actor_spans_task_started ON actor_spans (task_id, started_at, id);
CREATE INDEX actor_spans_kind_name_started ON actor_spans (kind, name, started_at);
