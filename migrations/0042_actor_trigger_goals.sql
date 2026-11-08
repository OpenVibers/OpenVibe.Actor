-- phase: expand
-- HO3 (a goal that keeps going) and HO4 (the routine answers in its thread).
--
-- A goal is a trigger of kind goal: it keeps working toward GOAL->>'text' on its schedule, and each
-- run answers its done-test GOAL->>'done_test'. GOAL holds what the person set (the text, the
-- done-test, the run limit, the money budget and the deadline); the progress columns hold how far it
-- has got. A goal ends itself (state 'done' or paused with budget/deadline) and says so in the thread,
-- so the state check has to admit 'done'.
--
-- ANSWER_IN_CHAT is the routine's own switch (default on): each run's answer is posted into the
-- conversation that made the trigger, under its card. NOTIFY is off by default: the answer in the
-- chat is the telling, unless the person also asked to be told through OpenVibe's notifications.
ALTER TABLE actor_triggers ADD COLUMN IF NOT EXISTS goal jsonb;
ALTER TABLE actor_triggers ADD COLUMN IF NOT EXISTS runs_used integer NOT NULL DEFAULT 0;
ALTER TABLE actor_triggers ADD COLUMN IF NOT EXISTS spent_usd double precision NOT NULL DEFAULT 0;
ALTER TABLE actor_triggers ADD COLUMN IF NOT EXISTS verdict jsonb;
ALTER TABLE actor_triggers ADD COLUMN IF NOT EXISTS answer_in_chat boolean NOT NULL DEFAULT true;
ALTER TABLE actor_triggers ADD COLUMN IF NOT EXISTS notify boolean NOT NULL DEFAULT false;
ALTER TABLE actor_triggers ADD COLUMN IF NOT EXISTS ended_at bigint;

-- 0037 wrote the state check inline, so PostgreSQL named it actor_triggers_state_check. A goal that
-- reached its done-test is 'done', not paused: it is over, and resuming it would make no sense.
ALTER TABLE actor_triggers DROP CONSTRAINT IF EXISTS actor_triggers_state_check;
ALTER TABLE actor_triggers ADD CONSTRAINT actor_triggers_state_check CHECK (state IN ('active','paused','done','deleted'));

-- The third kind: a goal that keeps going until its own check passes.
ALTER TABLE actor_triggers DROP CONSTRAINT IF EXISTS actor_triggers_kind_check;
ALTER TABLE actor_triggers ADD CONSTRAINT actor_triggers_kind_check CHECK (kind IN ('schedule','event','goal'));

-- A goal's own kind, for the queries that only look at live goals.
CREATE INDEX IF NOT EXISTS actor_triggers_goal ON actor_triggers (owner) WHERE kind = 'goal' AND deleted_at IS NULL;

-- What a run cost, so a goal's money budget is the sum of its runs and not a guess.
ALTER TABLE actor_trigger_runs ADD COLUMN IF NOT EXISTS cost_usd double precision;
