-- phase: expand
-- HO6 (channels): an agent answers the mail sent to its own address.
--
-- Mail publishes mail.agent_inbox.received for an inbox whose answering switch the person turned on. Actor takes it,
-- runs that agent for its owner with the mail as INPUT DATA, and answers:
--
--   * to the owner's own openvibe.email addresses, directly (Mail delivers those locally);
--   * to anyone else, as an HO1 approval of kind "send" that stays pending until the person decides (and, until Mail
--     may send outside OpenVibe, stays pending with the plain sentence saying the reply waits).
--
-- Three tables, each one thing:
--
--   actor_mail_threads  ONE thread per mail conversation, keyed by the Message-ID chain's root, so a back-and-forth
--                       stays one Actor thread with its memory (the run continues from the previous task).
--   actor_mail_inboxes  the person's switch and counters, keyed by the inbox id Mail gave: whether Actor answers at
--                       all for that address, and the two hourly windows the brief puts on it.
--   actor_mail_runs     one row per letter Actor took, so a redelivery makes no second run (the message id is the
--                       key) and the agent's page can list the last ten it answered with their thread.
--
-- Expand only: new tables, nothing renamed or dropped; an earlier release reads none of them.

CREATE TABLE IF NOT EXISTS actor_mail_threads (
    owner        text COLLATE "C" NOT NULL,                 -- user:usr_…
    thread_key   text COLLATE "C" NOT NULL,                 -- the conversation's root Message-ID, or the letter's own
    inbox_id     text COLLATE "C" NOT NULL,                 -- agi_… (Mail's inbox id)
    agent_id     text COLLATE "C" NOT NULL,                 -- agt_… (Actor's agent)
    peer         text COLLATE "C" NOT NULL,                 -- the other person's address, lowercased
    task_id      text COLLATE "C",                          -- the latest run of the thread
    created_at   text COLLATE "C" NOT NULL,
    updated_at   text COLLATE "C" NOT NULL,
    PRIMARY KEY (owner, thread_key)
);

CREATE INDEX IF NOT EXISTS actor_mail_threads_inbox_idx ON actor_mail_threads (owner, inbox_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS actor_mail_inboxes (
    owner        text COLLATE "C" NOT NULL,
    inbox_id     text COLLATE "C" NOT NULL,
    agent_id     text COLLATE "C" NOT NULL,
    address      text COLLATE "C" NOT NULL,
    enabled      boolean NOT NULL DEFAULT false,            -- off unless the person turned it on
    changed_at   text COLLATE "C" NOT NULL,
    PRIMARY KEY (owner, inbox_id)
);

CREATE TABLE IF NOT EXISTS actor_mail_runs (
    message_id   text COLLATE "C" PRIMARY KEY,              -- Mail's message id: a redelivery is a no-op
    message_rfc_id text COLLATE "C",                         -- the letter's own Message-ID, so a reply can find its thread
    owner        text COLLATE "C" NOT NULL,
    inbox_id     text COLLATE "C" NOT NULL,
    agent_id     text COLLATE "C" NOT NULL,
    thread_key   text COLLATE "C" NOT NULL,
    peer         text COLLATE "C" NOT NULL,
    subject      text COLLATE "C",
    task_id      text COLLATE "C",
    reply_state  text COLLATE "C" NOT NULL DEFAULT 'queued', -- queued | sent | awaiting_person | refused | failed
    reply_to     text COLLATE "C",
    approval_id  text COLLATE "C",
    reason       text COLLATE "C",
    created_at   text COLLATE "C" NOT NULL,
    updated_at   text COLLATE "C" NOT NULL
);

CREATE INDEX IF NOT EXISTS actor_mail_runs_rfc_idx ON actor_mail_runs (owner, inbox_id, message_rfc_id);
CREATE INDEX IF NOT EXISTS actor_mail_runs_owner_idx ON actor_mail_runs (owner, inbox_id, created_at DESC);
-- The two hourly windows (per inbox, and per sender): a count over the runs this hour is all it needs.
CREATE INDEX IF NOT EXISTS actor_mail_runs_peer_idx ON actor_mail_runs (owner, inbox_id, peer, created_at DESC);
