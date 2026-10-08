-- phase: expand
-- OpenVibe.Actor: tasks (platform.task@1), each task's event log (actor.task-event@1) and what each requester spent
-- per UTC day (budgets and the free allowance; requester '*' is everyone, the operator's daily ceiling). Nothing here
-- is ever a credential, a key or a token.

CREATE TABLE tasks (
    id            text COLLATE "C" PRIMARY KEY,                      -- tsk_<ULID>
    requester     text COLLATE "C" NOT NULL,                         -- user:usr_… | app:app_… | agent:agt_… | service:<slug>
    project_id    text COLLATE "C",                                  -- prj_<ULID> when the token named one
    task          text NOT NULL,
    mode          text COLLATE "C" NOT NULL,
    agent         text COLLATE "C",                                  -- the agent system the caller pinned, if any
    budget_task   double precision NOT NULL,
    budget_day    double precision NOT NULL,
    state         text COLLATE "C" NOT NULL,
    result        jsonb,
    error_code    text COLLATE "C",
    error_detail  text,
    cost_usd      double precision,
    free_usd      double precision,
    explanation   jsonb,
    cancel_at     text COLLATE "C",
    cancel_by     text COLLATE "C",
    last_seq      integer NOT NULL DEFAULT 0,
    idem_key      text COLLATE "C",
    idem_hash     text COLLATE "C",
    created_at    text COLLATE "C" NOT NULL,
    finished_at   text COLLATE "C"
);
CREATE INDEX tasks_by_requester ON tasks (requester, id DESC);
CREATE UNIQUE INDEX tasks_idempotency ON tasks (requester, idem_key) WHERE idem_key IS NOT NULL;
CREATE INDEX tasks_open ON tasks (state) WHERE state IN ('queued', 'running', 'verifying');
CREATE INDEX tasks_created ON tasks (created_at);

CREATE TABLE task_events (
    task_id  text COLLATE "C" NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    seq      integer NOT NULL,
    body     jsonb NOT NULL,
    PRIMARY KEY (task_id, seq)
);

CREATE TABLE spend_daily (
    requester  text COLLATE "C" NOT NULL,
    day        text COLLATE "C" NOT NULL,                            -- YYYY-MM-DD, UTC
    usd        double precision NOT NULL DEFAULT 0,
    tasks      integer NOT NULL DEFAULT 0,
    PRIMARY KEY (requester, day)
);
