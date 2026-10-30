-- phase: expand
-- Actor v2, stage V2-4: the files and charts a task makes, kept in Actor's own PostgreSQL.
--
-- They are not on OpenVibe.Media: Actor holds no Media grant, and every read would be with Actor's own token, so the
-- owner check here is the one that matters (server/runtime/artifacts.js). The bytes stay here, private to the task's
-- owner.
--
-- owner is the person the task was for (user:usr_...), the same shape tasks.requester has, so the rows are exported
-- and deleted with the person (server/identity/account-data.js). A row goes with its task (ON DELETE CASCADE).
-- The bytes are the person's own file: nothing here is a secret, a token or a credential.
CREATE TABLE actor_artifacts (
    id text COLLATE "C" PRIMARY KEY,
    task_id text COLLATE "C" NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    owner text COLLATE "C" NOT NULL,
    name text COLLATE "C" NOT NULL,
    mime text COLLATE "C" NOT NULL,
    size integer NOT NULL CHECK (size >= 0),
    bytes bytea NOT NULL,
    created_at text COLLATE "C" NOT NULL
);
CREATE INDEX actor_artifacts_task ON actor_artifacts (task_id, created_at);
CREATE INDEX actor_artifacts_owner ON actor_artifacts (owner);
