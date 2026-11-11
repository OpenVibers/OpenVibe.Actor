-- phase: expand
-- A product conversation turn answered by Actor (one-engine slice): the content tier it answers under
-- (standard or uncensored). The uncensored tier is only for a task that names the person it is for, and
-- OpenVibe.AI checks that person's 18+ confirmation on the account before it answers on that tier. Nullable:
-- a task with no tier predates turns, and no read requires one.
ALTER TABLE tasks ADD COLUMN tier text;
