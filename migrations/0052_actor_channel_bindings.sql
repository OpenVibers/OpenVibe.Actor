-- phase: expand
-- One channel account has one receiving agent. A null agent is an explicit unbind;
-- keeping the row prevents the legacy mail address from silently binding again.
CREATE TABLE actor_channel_bindings (
    kind text COLLATE "C" NOT NULL CHECK (kind IN ('mail', 'telegram', 'discord', 'slack')),
    account_id text COLLATE "C" NOT NULL,
    owner text COLLATE "C" NOT NULL,
    label text NOT NULL,
    agent_id text COLLATE "C" REFERENCES actor_agents (id) ON DELETE SET NULL,
    changed_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (kind, account_id)
);
CREATE INDEX actor_channel_bindings_owner ON actor_channel_bindings (owner, agent_id);
INSERT INTO actor_channel_bindings (kind, account_id, owner, label, agent_id, changed_at)
    SELECT 'mail', i.inbox_id, i.owner, i.address, a.id, i.changed_at
    FROM actor_mail_inboxes i LEFT JOIN actor_agents a ON a.id = i.agent_id AND a.owner = i.owner;
ALTER TABLE actor_mail_runs ADD COLUMN mail_agent_name text COLLATE "C";
