-- phase: expand
-- One Computer across Surf, Actor and the Dock (plan 2026-11-07): a step of the one timeline now names the Computer
-- it works on ({ session_id, machine, where, cost_hint }), the same object the task record and the task's own step
-- carry. It holds an id, a word for a machine and a cost phrase: no prompt, page or screen.
ALTER TABLE agent_timeline
    ADD COLUMN IF NOT EXISTS computer jsonb;
