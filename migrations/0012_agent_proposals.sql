-- phase: expand
-- Playbooks from outcomes (consumer plan step 4, "personal agents grow up"): after a run that passed its check, a
-- personal agent may suggest one line for its standing instructions (IMPROVE: …). The person applies it, dismisses it,
-- or undoes it later (server/agents/personal.js); nothing changes the instructions without them.
CREATE TABLE actor_agent_proposals (
    id text COLLATE "C" PRIMARY KEY,
    agent_id text COLLATE "C" NOT NULL REFERENCES actor_agents (id) ON DELETE CASCADE,
    owner text COLLATE "C" NOT NULL,
    text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 300),
    state text COLLATE "C" NOT NULL CHECK (state IN ('pending', 'applied', 'dismissed', 'undone')),
    from_task text COLLATE "C",
    previous_instructions text,
    applied_instructions text,
    created_at text COLLATE "C" NOT NULL,
    decided_at text COLLATE "C"
);
CREATE INDEX actor_agent_proposals_agent ON actor_agent_proposals (agent_id, created_at DESC);
