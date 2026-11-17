-- phase: expand
-- An answer's receipt (agents.step@1 1.3.0; plan §AD.17, "one agent system that always finds a way": every answer says
-- how it ran): what a turn took, what paid for it by rung of the ladder (OpenVibe's allowance, the person's own key,
-- their computer) and the model that wrote the answer. Written once when the turn ends (tasks/engine.js receiptOf);
-- the conversation's steps put it on the turn's answer (http/runs-api.js). Null for a turn that called no model.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS receipt jsonb;
