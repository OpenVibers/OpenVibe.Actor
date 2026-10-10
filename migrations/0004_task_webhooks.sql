-- phase: expand
-- OpenVibe.Actor: task webhooks (plan T17, actor.task-webhook@1). `webhooks` is what the task registered (url + the
-- state changes to deliver); `webhook_secret` signs its deliveries, minted per task, shown once to its creator and
-- erased once the task has ended and its deliveries are done. Each delivery is a row, retried with backoff; a delivery
-- never delays or changes the task. The secret is never exported (server/identity/account-data.js lists the columns).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS webhooks jsonb;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS webhook_secret text COLLATE "C";

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id           text COLLATE "C" PRIMARY KEY,                        -- whd_<ULID>, stable across retries
    task_id      text COLLATE "C" NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    url          text NOT NULL,
    state        text COLLATE "C" NOT NULL,                           -- the task state it announces
    body         jsonb NOT NULL,                                      -- actor.task-webhook@1 as it was then
    status       text COLLATE "C" NOT NULL DEFAULT 'pending',         -- pending | sending | delivered | failed
    attempts     integer NOT NULL DEFAULT 0,
    next_at      bigint NOT NULL,                                     -- epoch ms of the next attempt
    last_status  integer,
    last_error   text,
    created_at   text COLLATE "C" NOT NULL,
    finished_at  text COLLATE "C"
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries (next_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS webhook_deliveries_task ON webhook_deliveries (task_id);
