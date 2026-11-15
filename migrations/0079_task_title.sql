-- phase: expand
-- A conversation's own name (plan §AD.8: the session's ⋯ menu, Rename): the person names it; without one the title is
-- the first message, as before. Kept on the conversation's first turn (the root task).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS title text COLLATE "C";
