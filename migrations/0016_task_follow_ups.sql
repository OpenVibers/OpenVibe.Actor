-- phase: expand
-- Actor v2, stage V2-5b: a follow-up is a task that continues another, with that task's question and answer in mind.
--
-- parent_id is the task it follows up on, always the same person's (server/http/pages.js checks it before the
-- insert); NULL for a task that starts fresh. When a parent goes (retention, the person's deletion), its follow-ups
-- stay as tasks of their own.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_id text COLLATE "C" REFERENCES tasks (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks (parent_id) WHERE parent_id IS NOT NULL;
