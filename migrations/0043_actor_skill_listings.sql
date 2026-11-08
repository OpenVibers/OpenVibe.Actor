-- phase: expand
-- The skills registry (plan HO2, ADR-058): what Actor offers, and what one of a person's agents has installed.
--
-- A LISTING is the registry's own record of a skill (actor.skill-listing@1): the document as published, the
-- publisher the registry vouches for (the author inside a document is only a claim — nobody checks it), the scan's
-- state and its findings, and the curator's state. OpenVibe's own skills are publisher kind 'openvibe'; a person's
-- are 'person'. The listing is the only place a publisher is vouched for.
--
-- An INSTALL is one row per (person, agent, listing): the document as it was installed, its version, when it was
-- installed, when it was taken back, and when it was last loaded. Both tables go with the person
-- (server/identity/account-data.js): the installs are theirs, and so is a listing they published.
CREATE TABLE IF NOT EXISTS actor_skill_listings (
    id               text COLLATE "C" PRIMARY KEY,          -- skl_<ULID>
    slug             text COLLATE "C" NOT NULL,             -- the skill's own name in the registry
    skill            jsonb NOT NULL,                        -- the actor.skill@1 document as published
    publisher_kind   text COLLATE "C" NOT NULL CHECK (publisher_kind IN ('openvibe', 'person')),
    publisher_subject text COLLATE "C",                     -- usr_… (kind person); null for OpenVibe's own
    publisher_name   text,
    scan_state       text COLLATE "C" NOT NULL CHECK (scan_state IN ('pending', 'passed', 'flagged', 'failed')),
    scan             jsonb NOT NULL DEFAULT '{}'::jsonb,    -- the scanner, when it ran, and its findings
    curator_state    text COLLATE "C" NOT NULL CHECK (curator_state IN ('active', 'stale', 'archived')),
    curator          jsonb NOT NULL DEFAULT '{}'::jsonb,    -- last_used_at, near_duplicate_of
    installs         integer NOT NULL DEFAULT 0,
    listed_at        text COLLATE "C" NOT NULL,
    retired_at       text COLLATE "C",
    created_at       text COLLATE "C" NOT NULL,
    updated_at       text COLLATE "C" NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS actor_skill_listings_slug ON actor_skill_listings (slug);
CREATE INDEX IF NOT EXISTS actor_skill_listings_offered ON actor_skill_listings (curator_state, scan_state, listed_at DESC);

CREATE TABLE IF NOT EXISTS actor_skill_installs (
    id           text COLLATE "C" PRIMARY KEY,              -- ski_<ULID>
    owner        text COLLATE "C" NOT NULL,                -- user:usr_…
    agent_id     text COLLATE "C" NOT NULL,                 -- agt_…
    listing_id   text COLLATE "C" NOT NULL REFERENCES actor_skill_listings (id) ON DELETE CASCADE,
    skill        jsonb NOT NULL,                            -- the document as it was installed
    version      text COLLATE "C" NOT NULL,
    installed_at text COLLATE "C" NOT NULL,
    removed_at   text COLLATE "C",                          -- set when the person takes the skill back
    last_used_at text COLLATE "C"                           -- set when an agent loads the skill
);
CREATE UNIQUE INDEX IF NOT EXISTS actor_skill_installs_scope ON actor_skill_installs (owner, agent_id, listing_id);
CREATE INDEX IF NOT EXISTS actor_skill_installs_agent ON actor_skill_installs (owner, agent_id, installed_at DESC);
