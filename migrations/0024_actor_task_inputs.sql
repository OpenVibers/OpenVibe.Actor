-- phase: expand
-- Plan L55 C2: the files a person attaches to a message in the chat (the owner, 2026-11-01: "a whole conversation
-- system… where you can attach files"). server/tasks/inputs.js.
--
-- owner is the person the task is for (user:usr_...), as tasks.requester, so the rows are exported and deleted with the
-- person (server/identity/account-data.js); a row goes with its task (ON DELETE CASCADE). text is what the run reads:
-- a text file's text, or an image's description written when the task runs. The bytes are the person's own file:
-- nothing here is a secret, a token or a credential.
CREATE TABLE actor_task_inputs (
    id text COLLATE "C" PRIMARY KEY,
    task_id text COLLATE "C" NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    owner text COLLATE "C" NOT NULL,
    name text COLLATE "C" NOT NULL,
    mime text COLLATE "C" NOT NULL,
    size integer NOT NULL CHECK (size >= 0),
    bytes bytea NOT NULL,
    text text,
    created_at text COLLATE "C" NOT NULL
);
CREATE INDEX actor_task_inputs_task ON actor_task_inputs (task_id, created_at);
CREATE INDEX actor_task_inputs_owner ON actor_task_inputs (owner);
