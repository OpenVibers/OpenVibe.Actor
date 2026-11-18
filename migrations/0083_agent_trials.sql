-- phase: expand
-- Try an Expert before installing it (plan §AD.28 item 9; the Experts gallery, openvibe.actor/experts): a trial agent
-- is the Expert's persona (name, face, soul and instructions) with nothing it may do granted (no apps, no computer, no
-- memory, level ask), made for one person and hidden from their agents. trial_of names the blueprint; trial_until is
-- when "Try it" makes a fresh one instead of reusing it. Installing the Expert makes a real agent; the trial stays
-- hidden. Expand-only: two nullable columns.
ALTER TABLE actor_agents ADD COLUMN IF NOT EXISTS trial_of text COLLATE "C";
ALTER TABLE actor_agents ADD COLUMN IF NOT EXISTS trial_until timestamptz;
CREATE INDEX IF NOT EXISTS actor_agents_trials ON actor_agents (owner, trial_of) WHERE trial_of IS NOT NULL;
