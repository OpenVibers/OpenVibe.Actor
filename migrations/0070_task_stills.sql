-- phase: expand
-- See it work (W1): the picture each step saw, for a finished run's replay. The bytes are Actor's own (30-day task
-- retention); secret fields are blanked by the desk's curtain before the picture ever leaves it.
CREATE TABLE IF NOT EXISTS actor_task_stills (
    task_id text NOT NULL,
    seq     integer NOT NULL,
    tool    text,
    mime    text NOT NULL,
    width   integer,
    height  integer,
    bytes   bytea NOT NULL,
    at      timestamptz NOT NULL,
    PRIMARY KEY (task_id, seq)
);
CREATE INDEX IF NOT EXISTS actor_task_stills_task_at ON actor_task_stills (task_id, at);
