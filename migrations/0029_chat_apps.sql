-- phase: expand
CREATE TABLE actor_chat_tasks (
    task_id text PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    agent_id text NOT NULL REFERENCES actor_agents(id) ON DELETE CASCADE,
    policy text NOT NULL CHECK (policy IN ('dm', 'answer_only', 'act_with_approvals')),
    conversation text NOT NULL
);
CREATE TABLE actor_chat_approvals (
    id text PRIMARY KEY,
    task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    owner text NOT NULL,
    summary text NOT NULL,
    tool text NOT NULL,
    input jsonb NOT NULL,
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'declined')),
    expires_at text NOT NULL,
    consumed_at text
);
