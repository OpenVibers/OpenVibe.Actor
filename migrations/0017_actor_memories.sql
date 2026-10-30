-- phase: expand
-- Actor v2, stage V2-6: memory a person can see and edit.
--
-- This extends the memory Actor already had (actor_agent_memory, 0005_personal_agents.sql) rather than adding a second
-- store: a personal agent's notes and the person's own notes across tasks now live in one table.
--   agent_id NULL   the person's own memory, usable in any task or run
--   agent_id set    a note that belongs to one personal agent (its 50-note cap is unchanged)
--   origin          'person' (the person wrote or said it) or 'agent' (the agent suggested it); the code and the
--                   API call the same value `source`, but the column keeps its 0005 name so the old release runs
--   status          'active' | 'suggested' | 'archived'; only active memories are recalled or put in a prompt
--   kind            'fact' | 'preference' | 'instruction'
--   source_task     the task a memory came from, when it came from one
--   last_used_at    when recall last returned it; uses counts how often
--
-- The column keeps the name `origin`: an expand migration may only add things, and the previous release still writes
-- it while this runs. Nothing is dropped; old rows keep their text and created_order, and an old-style INSERT keeps
-- working. server/memory/index.js calls the value `source` in its own output only.
--
-- Security: every existing agent-written note becomes a suggestion. Before this stage an agent's own REMEMBER line was
-- active as soon as it was written, which let a page the agent read put words in its mouth. A suggestion does nothing
-- until the person accepts it on /memory (server/memory/index.js enforces the same rule for new writes).
ALTER TABLE actor_agent_memory ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE actor_agent_memory ADD COLUMN kind text COLLATE "C" NOT NULL DEFAULT 'fact' CHECK (kind IN ('fact', 'preference', 'instruction'));
ALTER TABLE actor_agent_memory ADD COLUMN status text COLLATE "C" NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suggested', 'archived'));
ALTER TABLE actor_agent_memory ADD COLUMN source_task text COLLATE "C" REFERENCES tasks (id) ON DELETE SET NULL;
ALTER TABLE actor_agent_memory ADD COLUMN last_used_at text COLLATE "C";
ALTER TABLE actor_agent_memory ADD COLUMN uses integer NOT NULL DEFAULT 0 CHECK (uses >= 0);
-- The old release may keep writing up to its old 1000-character limit. The 500-character limit is enforced for new
-- writes in code only (MAX_TEXT in server/memory/index.js); an existing longer row is kept, listed, edited and exported.
UPDATE actor_agent_memory SET status = 'suggested' WHERE origin = 'agent';
CREATE INDEX actor_agent_memory_owner_status ON actor_agent_memory (owner, status);

-- "Tell me when it's done": at most one Network notification per task per outcome. The row is the claim, so a
-- duplicated end (or a second needs-you hand-off in one run) never tells the person twice. It goes with the task.
CREATE TABLE actor_task_notices (
    task_id text COLLATE "C" NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    kind text COLLATE "C" NOT NULL CHECK (kind IN ('succeeded', 'failed', 'needs_you')),
    sent_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (task_id, kind)
);
