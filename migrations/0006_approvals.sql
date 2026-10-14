-- phase: expand
-- Plan T17 "an approval inbox for consequential actions": what a person's own agent asked to do while they were away
-- (a coding task on their machine), waiting for their yes or no. Nothing runs until they approve; approving starts it
-- as the person's own task. Kept with the person's data (account export and deletion).
CREATE TABLE actor_approvals (
    id text COLLATE "C" PRIMARY KEY,                                  -- apr_<ULID>
    owner text COLLATE "C" NOT NULL,                                  -- user:usr_…
    agent_id text COLLATE "C",                                        -- agt_… that asked
    task_id text COLLATE "C",                                         -- the agent run that asked
    kind text COLLATE "C" NOT NULL CHECK (kind IN ('codes.task')),
    summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 500),
    payload jsonb NOT NULL,
    state text COLLATE "C" NOT NULL CHECK (state IN ('pending', 'approved', 'declined', 'expired')),
    result_task_id text COLLATE "C",                                  -- the task approving started
    created_at text COLLATE "C" NOT NULL,
    expires_at text COLLATE "C" NOT NULL,
    decided_at text COLLATE "C"
);
CREATE INDEX actor_approvals_owner ON actor_approvals (owner, created_at DESC);
