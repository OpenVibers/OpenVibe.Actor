-- phase: expand
-- Personal agents belong to a person; their runs remain ordinary tasks.
CREATE TABLE actor_agents (
    id text COLLATE "C" PRIMARY KEY,
    owner text COLLATE "C" NOT NULL,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    instructions text NOT NULL CHECK (char_length(instructions) BETWEEN 1 AND 4000),
    mode text COLLATE "C" NOT NULL CHECK (mode IN ('cheapest', 'balanced', 'best', 'fastest', 'private')),
    budget_per_run_usd double precision NOT NULL CHECK (budget_per_run_usd > 0),
    daily_runs_max integer NOT NULL CHECK (daily_runs_max BETWEEN 1 AND 24),
    schedule text COLLATE "C" NOT NULL CHECK (schedule IN ('off', 'hourly', 'daily', 'weekly')),
    schedule_at text COLLATE "C",
    schedule_dow integer CHECK (schedule_dow BETWEEN 0 AND 6),
    next_run_at text COLLATE "C",
    last_run_at text COLLATE "C",
    last_skip_reason text,
    status text COLLATE "C" NOT NULL CHECK (status IN ('active', 'paused')),
    created_at text COLLATE "C" NOT NULL,
    updated_at text COLLATE "C" NOT NULL
);
CREATE INDEX actor_agents_owner ON actor_agents (owner, id DESC);
CREATE INDEX actor_agents_due ON actor_agents (next_run_at) WHERE status = 'active' AND schedule != 'off';

CREATE TABLE actor_agent_memory (
    id text COLLATE "C" PRIMARY KEY,
    created_order bigint GENERATED ALWAYS AS IDENTITY,
    agent_id text COLLATE "C" NOT NULL REFERENCES actor_agents (id) ON DELETE CASCADE,
    owner text COLLATE "C" NOT NULL,
    text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 1000),
    origin text COLLATE "C" NOT NULL CHECK (origin IN ('person', 'agent')),
    created_at text COLLATE "C" NOT NULL,
    updated_at text COLLATE "C" NOT NULL
);
CREATE INDEX actor_agent_memory_agent ON actor_agent_memory (agent_id, created_order DESC);
CREATE INDEX actor_agent_memory_owner ON actor_agent_memory (owner, id DESC);
