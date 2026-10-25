-- phase: expand
-- Each run is a chat you can open (consumer plan §4, the Vibe app's Tasks): a personal agent's run that passed its check
-- goes to its owner's own Vibe chat named after the agent, on OpenVibe.Chat (capability chat.vibe.deliver;
-- server/agents/vibe-deliver.js). send_to_vibe is the agent's switch, on by default; actor_vibe_deliveries keeps what was
-- sent, and retries what was not.
ALTER TABLE actor_agents ADD COLUMN send_to_vibe boolean NOT NULL DEFAULT true;
CREATE TABLE actor_vibe_deliveries (
    task_id text COLLATE "C" PRIMARY KEY,
    owner text COLLATE "C" NOT NULL,
    agent_id text COLLATE "C" NOT NULL,
    state text COLLATE "C" NOT NULL CHECK (state IN ('pending', 'sent', 'failed')),
    attempts integer NOT NULL DEFAULT 0,
    next_at text COLLATE "C" NOT NULL,
    chat_url text,
    error text,
    created_at text COLLATE "C" NOT NULL,
    sent_at text COLLATE "C"
);
CREATE INDEX actor_vibe_deliveries_due ON actor_vibe_deliveries (state, next_at);
CREATE INDEX actor_vibe_deliveries_owner ON actor_vibe_deliveries (owner);
