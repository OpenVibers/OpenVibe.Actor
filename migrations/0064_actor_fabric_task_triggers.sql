-- phase: expand
-- Keep the exact source inputs assigned to each stored task so a successful report can mark only those inputs read.
ALTER TABLE actor_fabric_tasks ADD COLUMN trigger_ids text[] NOT NULL DEFAULT '{}';
