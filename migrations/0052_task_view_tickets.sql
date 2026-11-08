-- phase: expand
CREATE TABLE task_view_tickets (
    token_hash text PRIMARY KEY,
    task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    requester text NOT NULL,
    expires_at timestamptz NOT NULL
);
CREATE INDEX task_view_tickets_expiry ON task_view_tickets(expires_at);
