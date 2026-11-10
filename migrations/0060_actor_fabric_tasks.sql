-- phase: expand
-- S4 executor adapters: one row binding a fabric Ticket to the Actor runtime task that runs it. Written in the
-- task's own insert transaction (server/fabric/adapters.js afterInsert), so a task can never exist without its
-- Ticket binding and a task end can always find the report target. The fabric aggregate remains the boundary for
-- Triggers, mandates and work; this table is the task-to-Ticket index only.
CREATE TABLE actor_fabric_tasks (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES actor_agents(id) ON DELETE CASCADE,
    owner TEXT NOT NULL,
    ticket_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX actor_fabric_tasks_owner ON actor_fabric_tasks(owner, agent_id);
