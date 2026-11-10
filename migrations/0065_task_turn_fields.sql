-- phase: expand
-- A product conversation turn answered by Actor (one-engine slice): which product conversation this task
-- answers, and the registry tool names the run may call (an empty list answers with no tool calls). Both
-- ride on the row so the run can honor them and a later query can find the turn's task. Nullable: older
-- tasks predate turns, and no read requires them.
ALTER TABLE tasks ADD COLUMN conversation jsonb;
ALTER TABLE tasks ADD COLUMN tools jsonb;
-- The model the product asked for (an exact model id, resolved by OpenVibe.AI like one the person picked).
ALTER TABLE tasks ADD COLUMN model text;
