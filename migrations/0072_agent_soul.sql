-- phase: expand
-- An agent's soul (actor-characters.md §3; agents.soul@1 in Contracts 0.424.0; Design rules 175 actor-is-the-work and
-- 176 souls-grow-by-yes): who it is in plain words, kept apart from its instructions and its memory. Null is an agent
-- made before souls. It changes only with its person's yes: a suggestion waits in actor_agent_proposals as kind 'soul'
-- and is applied by the existing decide flow, never written by the agent itself.
ALTER TABLE actor_agents ADD COLUMN IF NOT EXISTS soul jsonb;

-- Suggestions may be about a soul too. The kind was added by migration 0050 with a check on ('line', 'skill');
-- widening it is additive: every existing row still passes.
ALTER TABLE actor_agent_proposals DROP CONSTRAINT IF EXISTS actor_agent_proposals_kind_check;
ALTER TABLE actor_agent_proposals ADD CONSTRAINT actor_agent_proposals_kind_check CHECK (kind IN ('line', 'skill', 'soul'));
