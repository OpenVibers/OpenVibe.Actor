-- phase: expand
-- A-2 (plan §12): one record for all delegated work. actor_assignments is the tree of hand-offs — a person's task,
-- a routine or Watch run, an agent handing work to another agent, a Codes or Space task Actor started. Existing tasks
-- are not backfilled: the first read that needs one makes its root node lazily (server/agents/assignments.js). The
-- root's budget is the tree's budget; a child is refused once it is spent. A cancel cascades down the tree.
--
-- The approval inbox learns its second kind, actor.action: an acting tool (a send, a post, a purchase, a password
-- field, a deletion, a computer_run, a browser action, a Space publish) asks through the same gate as a coding task.
-- Widening the check keeps every old row valid; the old release can still write codes.task rows. Nothing is renamed
-- or dropped.
CREATE TABLE actor_assignments (
    id              text COLLATE "C" PRIMARY KEY,                    -- asg_<ULID>
    owner           text COLLATE "C" NOT NULL,                       -- user:usr_…
    root            text COLLATE "C" NOT NULL,                       -- the root node whose budget the tree spends
    parent          text COLLATE "C",                                -- the node that handed this work over (null on a root)
    depth           integer NOT NULL DEFAULT 0 CHECK (depth >= 0),
    origin          text COLLATE "C" NOT NULL CHECK (origin IN ('person', 'routine', 'outside')),
    mode            text COLLATE "C" NOT NULL CHECK (mode IN ('work', 'consult', 'notify')),
    reply           text COLLATE "C" NOT NULL CHECK (reply IN ('resume', 'poll', 'none')),
    agent_id        text COLLATE "C",                                -- agt_… that ran this hand-off
    task_id         text COLLATE "C" REFERENCES tasks (id) ON DELETE CASCADE,
    level           text COLLATE "C" NOT NULL CHECK (level IN ('ask', 'auto-edits', 'approve-for-me', 'full')),
    effective_level text COLLATE "C" NOT NULL CHECK (effective_level IN ('ask', 'auto-edits', 'approve-for-me', 'full')),
    budget_usd      double precision NOT NULL DEFAULT 0,             -- the root's budget, the same on every node
    budget_spent_usd double precision NOT NULL DEFAULT 0,            -- the root's spend as last written
    state           text COLLATE "C" NOT NULL CHECK (state IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
    created_at      text COLLATE "C" NOT NULL,
    updated_at      text COLLATE "C" NOT NULL,
    started_at      text COLLATE "C",
    ended_at        text COLLATE "C"
);
CREATE INDEX actor_assignments_owner ON actor_assignments (owner, created_at DESC);
CREATE INDEX actor_assignments_root ON actor_assignments (root, created_at);
CREATE INDEX actor_assignments_parent ON actor_assignments (parent, created_at);
-- One root per task; a task may be named by several child nodes (a sub-agent's consult, a Codes task) but only one
-- root is made lazily for it.
CREATE UNIQUE INDEX actor_assignments_one_root ON actor_assignments (task_id) WHERE depth = 0 AND task_id IS NOT NULL;

ALTER TABLE tasks ADD COLUMN assignment_id text COLLATE "C";

ALTER TABLE actor_approvals DROP CONSTRAINT actor_approvals_kind_check;
ALTER TABLE actor_approvals ADD CONSTRAINT actor_approvals_kind_check CHECK (kind IN ('codes.task', 'actor.action'));
