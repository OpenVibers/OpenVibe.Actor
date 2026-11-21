-- phase: expand
-- Teach, modular (plan §AD.33; the owner, 2026-11-21: "build modular intelligent teach feature"). A lesson is shown on
-- the agent's desk (source desk, as before) or told in words (source words: the skill is written from them, no desk);
-- the details that change each time are found in the demonstration and kept as examples; and once the person keeps the
-- skill the agent practises it on its desk with those examples, improving it after a failed try, up to practice_rounds
-- tries (0 off, 1, or 3: until it works). Expand-only: nullable or defaulted columns and an index.
ALTER TABLE actor_teach_sessions ADD COLUMN IF NOT EXISTS source text COLLATE "C" NOT NULL DEFAULT 'desk' CHECK (source IN ('desk', 'words'));
ALTER TABLE actor_teach_sessions ADD COLUMN IF NOT EXISTS words text CHECK (words IS NULL OR char_length(words) <= 6000);
ALTER TABLE actor_teach_sessions ADD COLUMN IF NOT EXISTS examples jsonb;
ALTER TABLE actor_teach_sessions ADD COLUMN IF NOT EXISTS practice_rounds integer NOT NULL DEFAULT 0 CHECK (practice_rounds BETWEEN 0 AND 3);
ALTER TABLE actor_teach_sessions ADD COLUMN IF NOT EXISTS practice_done integer NOT NULL DEFAULT 0;
ALTER TABLE actor_teach_sessions ADD COLUMN IF NOT EXISTS practice_task text COLLATE "C";
ALTER TABLE actor_teach_sessions ADD COLUMN IF NOT EXISTS practice_state text COLLATE "C" CHECK (practice_state IS NULL OR practice_state IN ('running', 'passed', 'failed', 'not_started'));
ALTER TABLE actor_teach_sessions ADD COLUMN IF NOT EXISTS listing_id text COLLATE "C";
CREATE INDEX IF NOT EXISTS actor_teach_sessions_practice ON actor_teach_sessions (practice_task) WHERE practice_task IS NOT NULL;
