-- phase: expand
-- S5 observe records: an append-only read model of what a lane would have done (the gate's verdict and the estimated
-- cost), plus every promotion/demotion of a lane with its reason. The agent's JSONB aggregate remains the transaction
-- boundary: service.js mirrors new records into these tables in the same transaction that commits the aggregate.
CREATE TABLE actor_fabric_observe (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES actor_agents(id) ON DELETE CASCADE,
    owner TEXT NOT NULL,
    seq INTEGER NOT NULL,
    thread TEXT,
    rule_ids TEXT[] NOT NULL DEFAULT '{}',
    record JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX actor_fabric_observe_agent ON actor_fabric_observe(agent_id, seq DESC);
CREATE INDEX actor_fabric_observe_rules ON actor_fabric_observe USING gin (rule_ids);

CREATE TABLE actor_fabric_lane_changes (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES actor_agents(id) ON DELETE CASCADE,
    owner TEXT NOT NULL,
    seq INTEGER NOT NULL,
    rule_id TEXT NOT NULL,
    from_mode TEXT NOT NULL,
    to_mode TEXT NOT NULL,
    reason TEXT NOT NULL,
    actor TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX actor_fabric_lane_changes_agent ON actor_fabric_lane_changes(agent_id, seq DESC);
