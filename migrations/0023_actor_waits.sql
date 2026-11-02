-- phase: expand
-- Actor v2, plan A2 (Watch mode): a wait. A wait is a record, not a running loop.
--
-- One row per wait: the task and the step it belongs to, whose it is, what wakes it (until), the deadline, what
-- happens when nothing comes (on_timeout) and the short line the person reads. While a task waits, no model runs,
-- its desk is released and its budget clock stops (server/tasks/engine.js parks the run; server/waits/deadlines.js
-- fires the deadline once).
--
-- Nothing here is a credential, a key or a token. The event that woke the wait is named (woken_by) but its payload is
-- never stored: an event body is untrusted input (server/waits/match.js), and a row that kept it would keep a
-- stranger's text.
--
-- Expand only: three new tables and nothing else changed. An older release ignores them.
CREATE TABLE IF NOT EXISTS actor_waits (
    id            text COLLATE "C" PRIMARY KEY,        -- wai_<ULID>
    task_id       text COLLATE "C" NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    requester     text COLLATE "C" NOT NULL,           -- user:usr_… — whose wait it is
    step          integer,                             -- the plan step the run was on
    kind          text COLLATE "C" NOT NULL CHECK (kind IN ('event', 'watch', 'time')),
    until         jsonb NOT NULL,                      -- {topic, from?} | {watch_id} | {at}
    filter        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- the bounded matcher: path → value
    deadline_at   text COLLATE "C" NOT NULL,           -- ISO; the deadline fires once
    on_timeout    text COLLATE "C" NOT NULL CHECK (on_timeout IN ('ask', 'retry', 'fail')),
    line          text NOT NULL,                       -- the short line the person reads (<= 200 chars)
    status        text COLLATE "C" NOT NULL DEFAULT 'waiting'
                  CHECK (status IN ('waiting', 'woken', 'timed_out', 'cancelled', 'failed')),
    trace_id      text COLLATE "C",                    -- the run that created it: the loop guard
    woken_by      jsonb,                               -- {event_id, event_type, at, by} — never the payload
    retries       integer NOT NULL DEFAULT 0,
    remaining_ms  integer,                             -- the wall clock the task had left when it parked
    created_at    text COLLATE "C" NOT NULL,
    updated_at    text COLLATE "C" NOT NULL,
    finished_at   text COLLATE "C"
);
CREATE INDEX IF NOT EXISTS actor_waits_open ON actor_waits (status, deadline_at) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS actor_waits_task ON actor_waits (task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS actor_waits_requester ON actor_waits (requester, created_at DESC);

-- The event a wait was woken by, kept so the same event never wakes a wait twice (the loop guard, server/waits/guard.js).
-- The receipt is the event's id and nothing else: no payload, no body.
CREATE TABLE IF NOT EXISTS actor_wait_events (
    event_id   text COLLATE "C" PRIMARY KEY,
    wait_id    text COLLATE "C" NOT NULL REFERENCES actor_waits (id) ON DELETE CASCADE,
    event_type text COLLATE "C" NOT NULL,
    at         text COLLATE "C" NOT NULL
);
CREATE INDEX IF NOT EXISTS actor_wait_events_wait ON actor_wait_events (wait_id);

-- One cursor per topic, never one per wait: the position in OpenVibe.Events is an opaque cursor (server/cursor.js),
-- and a wait only says which topic it wants. The cursor is the service's, not a person's: it is not in the account
-- data map.
CREATE TABLE IF NOT EXISTS actor_event_cursors (
    topic      text COLLATE "C" PRIMARY KEY,          -- the topic pattern
    cursor     text COLLATE "C",
    updated_at text COLLATE "C" NOT NULL
);
