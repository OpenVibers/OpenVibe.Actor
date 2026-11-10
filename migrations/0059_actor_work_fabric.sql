-- phase: expand
-- S4: an agent is the transaction boundary. Commands run synchronously on its locked aggregate;
-- source cursors, immutable events, mandates and the ordered outbox commit together.
-- Separate from actor_task_view tickets: those are a read model for existing runtime tasks.
CREATE TABLE actor_work_fabric (
    agent_id TEXT PRIMARY KEY REFERENCES actor_agents(id) ON DELETE CASCADE,
    owner TEXT NOT NULL,
    revision BIGINT NOT NULL DEFAULT 0,
    state JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX actor_work_fabric_owner ON actor_work_fabric(owner);
