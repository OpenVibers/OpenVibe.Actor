-- phase: expand
-- Plan L55 C3, "Runs on: my computer": where a person's tasks run. 'openvibe' (the default, today's behaviour) or
-- 'computer' (every turn goes to OpenVibe.Codes on the person's own paired machine; robot and computer-control tasks
-- keep their own agents). A new column with a default: every row stays valid, and the code before this one never reads
-- or writes it.
ALTER TABLE actor_model_prefs ADD COLUMN IF NOT EXISTS runs_on text NOT NULL DEFAULT 'openvibe';
ALTER TABLE actor_model_prefs DROP CONSTRAINT IF EXISTS actor_model_prefs_runs_on_check;
ALTER TABLE actor_model_prefs ADD CONSTRAINT actor_model_prefs_runs_on_check CHECK (runs_on IN ('openvibe', 'computer'));
