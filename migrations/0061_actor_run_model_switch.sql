-- phase: expand
-- A4: a model selected for the next step, and the switches that happened during an Actor run.
ALTER TABLE actor_day_runs ADD COLUMN model_override text;
ALTER TABLE actor_day_runs ADD COLUMN model_switches jsonb NOT NULL DEFAULT '[]'::jsonb;
