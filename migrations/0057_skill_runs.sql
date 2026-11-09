-- phase: expand
-- A catalogue skill can start a normal Actor task; these labels keep its Dock row about the work, not its prompt.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS skill_slug text COLLATE "C";
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS skill_name text COLLATE "C";
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS skill_subject_title text COLLATE "C";
