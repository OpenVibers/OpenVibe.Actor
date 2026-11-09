-- phase: expand
-- A1: off by default; the due date and the active run survive process restarts.
CREATE TABLE actors (
    id text COLLATE "C" PRIMARY KEY,
    owner text COLLATE "C" NOT NULL UNIQUE,
    name text NOT NULL DEFAULT 'My Actor',
    avatar jsonb,
    brain text NOT NULL DEFAULT 'auto',
    computer jsonb NOT NULL DEFAULT '{"kind":"none"}',
    caps jsonb NOT NULL DEFAULT '{"usd":1,"minutes":60,"balance_floor_usd":0.05}',
    enabled boolean NOT NULL DEFAULT false,
    status text NOT NULL DEFAULT 'paused' CHECK (status IN ('working','resting','paused')),
    next_due_at text COLLATE "C" NOT NULL,
    active_task text COLLATE "C",
    created_at text COLLATE "C" NOT NULL,
    updated_at text COLLATE "C" NOT NULL
);
CREATE INDEX actors_due ON actors(next_due_at) WHERE enabled;
CREATE TABLE actor_day_goals (
    id text COLLATE "C" PRIMARY KEY,
    actor_id text COLLATE "C" NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
    owner text COLLATE "C" NOT NULL,
    text text NOT NULL,
    lane text NOT NULL CHECK (lane IN ('find_work','earn_gig','grow_channel','brief_me','watch_deals','build_it','inbox_zero','custom')),
    budget jsonb NOT NULL,
    asks_before jsonb NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    every_minutes integer NOT NULL DEFAULT 1440 CHECK (every_minutes >= 5),
    next_due_at text COLLATE "C" NOT NULL,
    deleted_at text COLLATE "C",
    created_at text COLLATE "C" NOT NULL,
    updated_at text COLLATE "C" NOT NULL
);
CREATE INDEX actor_day_goals_due ON actor_day_goals(actor_id,next_due_at);
CREATE TABLE actor_day_runs (
    task_id text COLLATE "C" PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    actor_id text COLLATE "C" NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
    goal_id text COLLATE "C" NOT NULL REFERENCES actor_day_goals(id) ON DELETE CASCADE,
    owner text COLLATE "C" NOT NULL,
    day text COLLATE "C" NOT NULL,
    reserved_usd double precision NOT NULL,
    reserved_ms bigint NOT NULL,
    active_ms bigint NOT NULL DEFAULT 0,
    segment_at text COLLATE "C",
    finished_at text COLLATE "C",
    created_at text COLLATE "C" NOT NULL
);
CREATE INDEX actor_day_runs_day ON actor_day_runs(actor_id,day);
CREATE TABLE actor_day_asks (
    id text COLLATE "C" PRIMARY KEY,
    actor_id text COLLATE "C" NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
    goal_id text COLLATE "C" NOT NULL REFERENCES actor_day_goals(id) ON DELETE CASCADE,
    owner text COLLATE "C" NOT NULL,
    task_id text COLLATE "C" NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    wait_id text COLLATE "C" NOT NULL REFERENCES actor_waits(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('approve_action','answer_question','do_yourself')),
    text text NOT NULL,
    options jsonb NOT NULL DEFAULT '[]',
    action_hash text,
    answered jsonb,
    used_at text COLLATE "C",
    notified_at text COLLATE "C",
    created_at text COLLATE "C" NOT NULL
);
CREATE INDEX actor_day_asks_task ON actor_day_asks(task_id);
CREATE TABLE actor_day_journal (
    id text COLLATE "C" PRIMARY KEY,
    actor_id text COLLATE "C" NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
    goal_id text COLLATE "C" REFERENCES actor_day_goals(id) ON DELETE SET NULL,
    owner text COLLATE "C" NOT NULL,
    task_id text COLLATE "C" REFERENCES tasks(id) ON DELETE SET NULL,
    text text NOT NULL,
    looking_at text,
    thumbnail jsonb,
    cost_usd double precision NOT NULL DEFAULT 0,
    created_at text COLLATE "C" NOT NULL
);
CREATE INDEX actor_day_journal_page ON actor_day_journal(actor_id,id DESC);
CREATE TABLE actor_day_messages (
    id text COLLATE "C" PRIMARY KEY,
    actor_id text COLLATE "C" NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
    owner text COLLATE "C" NOT NULL,
    text text NOT NULL,
    task_id text COLLATE "C" REFERENCES tasks(id) ON DELETE SET NULL,
    created_at text COLLATE "C" NOT NULL
);

-- Actual spend belongs to the UTC day it happened, including a run resumed after midnight.
CREATE TABLE actor_day_usage (
    actor_id text COLLATE "C" NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
    goal_id text COLLATE "C" NOT NULL REFERENCES actor_day_goals(id) ON DELETE CASCADE,
    owner text COLLATE "C" NOT NULL,
    day text COLLATE "C" NOT NULL,
    usd double precision NOT NULL DEFAULT 0,
    active_ms bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (goal_id,day)
);
CREATE INDEX actor_day_usage_actor ON actor_day_usage(actor_id,day);
