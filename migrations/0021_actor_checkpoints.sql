-- phase: expand
-- Actor v2, stage V2-9: a sealed checkpoint after every model step, so a run picks up after a restart, and any step can
-- be replayed or forked with one change.
--
-- state_enc is the loop's own state (messages, the ledgers, the evidence, the allow-list, the budget spent and the
-- tier) as JSON, sealed with AES-256-GCM under ACTOR_CHECKPOINT_KEY and bound to its task and step
-- (server/runtime/checkpoints.js). Nothing is stored in cleartext, and no secret or tool credential is ever inside:
-- server/runtime/checkpoints.js strips them before sealing.
--
-- The last 50 rows per task are kept (pruned after every write). A row goes with its task (ON DELETE CASCADE) and is
-- exported and erased with the person (server/identity/account-data.js). Additive only: a new table and three new
-- nullable task columns. An older release that does not know them ignores them.
CREATE TABLE actor_checkpoints (
    task_id    text COLLATE "C" NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    step       integer NOT NULL CHECK (step >= 0),
    created_at text COLLATE "C" NOT NULL,
    state_enc  text NOT NULL,
    PRIMARY KEY (task_id, step)
);
CREATE INDEX actor_checkpoints_task_step ON actor_checkpoints (task_id, step DESC);

-- A fork is a new task that starts from its parent's checkpoint at fork_of_step (parent_id is the parent, as a
-- follow-up already is); fork_change records the one change the person picked, so the page and the compare page can
-- say it. A resumed run counts its resumes, so the third interruption fails it instead of looping forever.
ALTER TABLE tasks ADD COLUMN fork_of_step integer CHECK (fork_of_step IS NULL OR fork_of_step >= 0);
ALTER TABLE tasks ADD COLUMN fork_change jsonb;
ALTER TABLE tasks ADD COLUMN resumes integer CHECK (resumes IS NULL OR resumes >= 0);
