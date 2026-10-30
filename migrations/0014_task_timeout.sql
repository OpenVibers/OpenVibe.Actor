-- phase: expand
-- Actor v2: a task's own clock. The engine sets it when the task is created: 10 minutes by default (config), up to
-- 60 minutes for mode best. A row without a value (older tasks) uses ACTOR_TASK_TIMEOUT_MS. Nothing here is a secret.
ALTER TABLE tasks ADD COLUMN timeout_ms integer;
