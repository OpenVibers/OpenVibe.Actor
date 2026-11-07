-- phase: expand
-- HO1 (universal approvals, the trust spine): every consequential act has a kind, so the person reads one plain
-- phrase for it on the approval page, in the Action Center and on the agent's own page. The kinds widen; every old
-- row stays valid and keeps its kind (codes.task, actor.action).
--
-- The request now also carries the exact TARGET it would touch ("publish to openvibe.blog", "run git status on
-- dev_x") and the always-ask categories it fell in, so the decision can be scoped and the floor can be checked
-- later without re-reading the tool's input.
--
-- "Always allow this for this agent" (agents/allows.js) is one row per (person, agent, kind, target): a standing
-- permission the person may revoke. It never covers the floor (money, a password, a deletion, a new recipient):
-- that is checked in levels.js and in agents/approvals.js, not here.
CREATE TABLE IF NOT EXISTS actor_approval_allows (
    id         text COLLATE "C" PRIMARY KEY,                 -- alw_<ULID>
    owner      text COLLATE "C" NOT NULL,                    -- user:usr_…
    agent_id   text COLLATE "C" NOT NULL,                    -- agt_… the permission is for
    kind       text COLLATE "C" NOT NULL,                    -- the kind of act it covers
    target     text COLLATE "C" NOT NULL,                    -- the exact target it is scoped to
    created_at text COLLATE "C" NOT NULL,
    revoked_at text COLLATE "C"                            -- set when the person takes it back
);
CREATE UNIQUE INDEX IF NOT EXISTS actor_approval_allows_scope
    ON actor_approval_allows (owner, agent_id, kind, target) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS actor_approval_allows_owner
    ON actor_approval_allows (owner, agent_id, created_at DESC);

ALTER TABLE actor_approvals ADD COLUMN IF NOT EXISTS target text COLLATE "C";
ALTER TABLE actor_approvals ADD COLUMN IF NOT EXISTS categories jsonb;
ALTER TABLE actor_approvals ADD COLUMN IF NOT EXISTS decision_scope text COLLATE "C";
ALTER TABLE actor_approvals ADD COLUMN IF NOT EXISTS decided_by text COLLATE "C";
ALTER TABLE actor_approvals ADD COLUMN IF NOT EXISTS allow_id text COLLATE "C";

ALTER TABLE actor_approvals DROP CONSTRAINT IF EXISTS actor_approvals_kind_check;
ALTER TABLE actor_approvals ADD CONSTRAINT actor_approvals_kind_check CHECK (kind IN (
    'codes.task', 'actor.action', 'computer.run', 'computer.write', 'computer.input', 'computer.browser',
    'computer.desk', 'robot.move', 'space', 'publish', 'post', 'send', 'install', 'routine', 'money'));
