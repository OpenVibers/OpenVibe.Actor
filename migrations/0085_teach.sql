-- phase: expand
-- Teach a task (plan §AD.33; the owner, 2026-11-20: "click on one of your actors and train it to do a task … it brings
-- up the desktop view, you do the task, and it trains based off what you do … self-improvement, recursive"). A teach
-- session is one task of one agent: its desk opens, the person does the task once while the desk records their steps
-- (server/teach/recorder.js), and a vision model writes those steps up as a private skill draft for that agent
-- (server/teach/draft.js). After any later run that used one of the person's own skills, where the person had to step in
-- or the run failed, the agent writes the skill's next version (server/teach/improve.js): applied at once with an undo
-- when the agent's skills_improve is 'auto' (the default), else waiting as a suggestion.
-- Expand-only: one new table and nullable (or defaulted) columns.
CREATE TABLE IF NOT EXISTS actor_teach_sessions (
    task_id text COLLATE "C" PRIMARY KEY REFERENCES tasks (id) ON DELETE CASCADE,
    owner text COLLATE "C" NOT NULL,
    agent_id text COLLATE "C" NOT NULL REFERENCES actor_agents (id) ON DELETE CASCADE,
    what text NOT NULL CHECK (char_length(what) BETWEEN 1 AND 300),
    start_url text CHECK (start_url IS NULL OR char_length(start_url) <= 2048),
    desk_kind text COLLATE "C" NOT NULL DEFAULT 'browser' CHECK (desk_kind IN ('browser', 'desktop')),
    state text COLLATE "C" NOT NULL DEFAULT 'started' CHECK (state IN ('started', 'watching', 'drafted', 'empty', 'failed')),
    steps integer NOT NULL DEFAULT 0,
    proposal_id text COLLATE "C",
    created_at text COLLATE "C" NOT NULL,
    ended_at text COLLATE "C"
);
CREATE INDEX IF NOT EXISTS actor_teach_sessions_agent ON actor_teach_sessions (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS actor_teach_sessions_owner ON actor_teach_sessions (owner, created_at DESC);

-- Where a skill draft came from (a checked run, a teach session, an improvement), the private skill an improvement
-- rewrites, and the version it replaced (the undo).
ALTER TABLE actor_agent_proposals ADD COLUMN IF NOT EXISTS source text COLLATE "C";
ALTER TABLE actor_agent_proposals ADD COLUMN IF NOT EXISTS updates_listing text COLLATE "C";
ALTER TABLE actor_agent_proposals ADD COLUMN IF NOT EXISTS previous jsonb;

-- Whether an agent improves its own skills after a run (auto: at once, with an undo) or suggests it (ask).
ALTER TABLE actor_agents ADD COLUMN IF NOT EXISTS skills_improve text COLLATE "C" NOT NULL DEFAULT 'auto';
