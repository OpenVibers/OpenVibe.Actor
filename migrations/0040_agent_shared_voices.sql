-- phase: expand
-- A voice shared by its owner: the public link (/voices/<id>) that lets somebody else borrow it. Actor's own record
-- of who shared it — the only place a voice's author is vouched for, because the author in a file is only a claim.
CREATE TABLE IF NOT EXISTS actor_shared_voices (
    id text COLLATE "C" PRIMARY KEY,
    owner text COLLATE "C" NOT NULL,
    owner_name text,
    agent_id text COLLATE "C" NOT NULL,
    voice jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS actor_shared_voices_owner_idx ON actor_shared_voices (owner, created_at DESC);
-- Whether the author of an imported voice may be vouched for: Actor's own record of a shared voice says yes; a file
-- says only what it claims, and the page says so.
ALTER TABLE actor_agents ADD COLUMN IF NOT EXISTS voice_author_checked boolean NOT NULL DEFAULT false;
-- The apps the voice an agent was imported from used: never connected for it (an app binds to the borrower's own
-- connections), shown on its page so the person adds the ones they want.
ALTER TABLE actor_agents ADD COLUMN IF NOT EXISTS voice_suggested_apps jsonb NOT NULL DEFAULT '[]'::jsonb;
