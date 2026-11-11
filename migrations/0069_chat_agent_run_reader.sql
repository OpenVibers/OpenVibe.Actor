-- phase: expand
-- A personal agent run keeps via=agent:<id> for its memory and daily cap. When Chat starts one as that person's
-- channel member, it alone may follow the task to bring the answer back to the channel.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS delegated_via text COLLATE "C";
