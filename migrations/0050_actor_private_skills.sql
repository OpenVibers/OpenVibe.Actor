-- phase: expand
-- HO11: an agent's skill draft waits for its person; kept skills belong to that person.
ALTER TABLE actor_agent_proposals ADD COLUMN kind text COLLATE "C" NOT NULL DEFAULT 'line' CHECK (kind IN ('line', 'skill'));
ALTER TABLE actor_agent_proposals ADD COLUMN draft jsonb;
ALTER TABLE actor_agent_proposals ADD COLUMN listing_id text COLLATE "C" REFERENCES actor_skill_listings (id);
CREATE UNIQUE INDEX actor_agent_proposals_one_skill_per_run ON actor_agent_proposals (agent_id, from_task) WHERE kind = 'skill' AND from_task IS NOT NULL;
ALTER TABLE actor_skill_listings ADD COLUMN visibility text COLLATE "C" NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private'));
ALTER TABLE actor_skill_listings ADD CONSTRAINT actor_skill_private_owner CHECK (visibility = 'public' OR (publisher_kind = 'person' AND publisher_subject IS NOT NULL));
CREATE INDEX actor_skill_listings_person ON actor_skill_listings (publisher_subject, visibility, listed_at DESC);
