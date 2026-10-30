-- phase: expand
-- The connections a person added (Actor v2, stage V2-11): an MCP server or an A2A agent.
-- Expand only: nothing here changes an existing table. A token is stored sealed (ACTOR_CONNECTOR_KEY), never in
-- plain text, and the person's tool choices live beside the connection they belong to.
CREATE TABLE IF NOT EXISTS actor_connections (
    id text PRIMARY KEY,
    owner text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('mcp', 'a2a')),
    name text NOT NULL,
    url text NOT NULL,
    header_name text,
    token_enc text,
    enabled boolean NOT NULL DEFAULT true,
    builtin boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    last_checked_at timestamptz,
    last_ok boolean,
    last_error text
);
CREATE INDEX IF NOT EXISTS actor_connections_owner ON actor_connections (owner, created_at);

CREATE TABLE IF NOT EXISTS actor_connection_tools (
    connection_id text NOT NULL REFERENCES actor_connections (id) ON DELETE CASCADE,
    name text NOT NULL,
    description text,
    input_schema jsonb,
    annotations jsonb,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (connection_id, name)
);
