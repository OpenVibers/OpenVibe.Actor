-- phase: expand
-- Quiet hours for personal agents (actor.agent-manage-request@1 quiet_from/quiet_to, contracts 0.214.0): HH:MM UTC, both
-- or neither; no scheduled run starts inside the window (it may cross midnight). A run the owner starts still runs.
ALTER TABLE actor_agents
    ADD COLUMN quiet_from text COLLATE "C" CHECK (quiet_from ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    ADD COLUMN quiet_to text COLLATE "C" CHECK (quiet_to ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    ADD CONSTRAINT actor_agents_quiet_pair CHECK ((quiet_from IS NULL) = (quiet_to IS NULL) AND (quiet_from IS NULL OR quiet_from <> quiet_to));
