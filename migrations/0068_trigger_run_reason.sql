-- phase: expand
-- Explain why a schedule or event subscription started each task.
ALTER TABLE actor_trigger_runs ADD COLUMN IF NOT EXISTS why text;
