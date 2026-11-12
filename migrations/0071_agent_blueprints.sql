-- phase: expand
-- Make your own agent (agent-blueprints.md, Contracts 0.419.0): a blueprint is an agent anyone can read, change, share
-- and run, as one document of ten parts. A blueprint row holds its draft (the next version) and who may see it; each
-- published version is frozen in agent_blueprint_versions; an install is a person's own agent (actor_agents) made from
-- one version, with the inputs they filled, the asks they agreed to and the machines they chose. Keys and grants are the
-- person's own and are never copied here.
CREATE TABLE IF NOT EXISTS agent_blueprints (
    id          text COLLATE "C" PRIMARY KEY,
    owner       text COLLATE "C" NOT NULL,
    visibility  text COLLATE "C" NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'link', 'public')),
    latest      integer CHECK (latest IS NULL OR latest >= 1),
    draft       jsonb,
    forked_from text COLLATE "C",
    installs    integer NOT NULL DEFAULT 0,
    remixes     integer NOT NULL DEFAULT 0,
    created_at  text COLLATE "C" NOT NULL,
    updated_at  text COLLATE "C" NOT NULL,
    deleted_at  text COLLATE "C"
);
CREATE INDEX IF NOT EXISTS agent_blueprints_owner ON agent_blueprints (owner, updated_at DESC);
CREATE INDEX IF NOT EXISTS agent_blueprints_public ON agent_blueprints (updated_at DESC) WHERE visibility = 'public' AND deleted_at IS NULL AND latest IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_blueprint_versions (
    blueprint_id text COLLATE "C" NOT NULL REFERENCES agent_blueprints (id) ON DELETE CASCADE,
    version      integer NOT NULL CHECK (version >= 1),
    doc          jsonb NOT NULL,
    state        text COLLATE "C" NOT NULL DEFAULT 'published' CHECK (state IN ('published', 'retired')),
    published_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (blueprint_id, version)
);

CREATE TABLE IF NOT EXISTS agent_installs (
    agent_id     text COLLATE "C" PRIMARY KEY REFERENCES actor_agents (id) ON DELETE CASCADE,
    owner        text COLLATE "C" NOT NULL,
    blueprint_id text COLLATE "C" NOT NULL,
    version      integer NOT NULL CHECK (version >= 1),
    inputs       jsonb NOT NULL DEFAULT '{}'::jsonb,
    agreed       jsonb NOT NULL DEFAULT '[]'::jsonb,
    places       jsonb NOT NULL DEFAULT '{}'::jsonb,
    updates      text COLLATE "C" NOT NULL DEFAULT 'ask' CHECK (updates IN ('ask', 'same-or-less')),
    pending      integer CHECK (pending IS NULL OR pending >= 1),
    installed_at text COLLATE "C" NOT NULL,
    updated_at   text COLLATE "C" NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_installs_blueprint ON agent_installs (blueprint_id, version);

-- A blueprint's instructions may be up to 20,000 characters (agents.blueprint@1); an agent installed from one keeps
-- them whole. Relaxing the check is backward compatible: every row that passed 4,000 passes 20,000.
ALTER TABLE actor_agents DROP CONSTRAINT IF EXISTS actor_agents_instructions_check;
ALTER TABLE actor_agents ADD CONSTRAINT actor_agents_instructions_check CHECK (char_length(instructions) BETWEEN 1 AND 20000);
