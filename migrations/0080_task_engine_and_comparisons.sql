-- phase: expand
-- Engines and comparisons (the owner, 2026-11-16: "Actor should allow a mix or modular system where you can use an agent
-- or harness or model system or a decisions API or swap between and benchmark the different ways our shit works").
-- tasks.engine: the way a person chose for this task ({ kind, model?, harness? }; null: Actor chooses, as before).
-- tasks.comparison_id: the comparison a task is one side of. actor_comparisons: one task run several ways side by side,
-- with the scores OpenVibe.AI's Decisions API gave each answer. The person's content: exported and erased with the
-- account (identity/account-data.js). Additive: two nullable columns and one new table.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS engine jsonb;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS comparison_id text;
CREATE INDEX IF NOT EXISTS tasks_comparison ON tasks (comparison_id) WHERE comparison_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS actor_comparisons (
    id          text PRIMARY KEY,
    requester   text NOT NULL,
    task        text NOT NULL,
    engines     jsonb NOT NULL,
    judged      jsonb,
    judged_at   timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS actor_comparisons_requester ON actor_comparisons (requester, created_at DESC);
