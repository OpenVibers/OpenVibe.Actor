-- phase: expand
-- An agent's voice as a file (actor.voice@1): the parts of an agent that make it the same voice in somebody
-- else's hands — a short bio, the rules it keeps, and where its voice came from (the author's subject and the
-- link it was imported from). Never memory, never a connector's token, never a file: a voice is a voice.
ALTER TABLE actor_agents ADD COLUMN IF NOT EXISTS bio text;
ALTER TABLE actor_agents ADD COLUMN IF NOT EXISTS rules jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE actor_agents ADD COLUMN IF NOT EXISTS voice_author text;
ALTER TABLE actor_agents ADD COLUMN IF NOT EXISTS voice_author_name text;
ALTER TABLE actor_agents ADD COLUMN IF NOT EXISTS voice_source text;
