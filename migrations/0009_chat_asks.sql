-- phase: expand
-- Plan T17 "Reach": a person asks Actor from OpenVibe chat ("@actor …" in the global chat or their own channel's
-- chat). One row per chat message that asked: the task it became, or why none was made, and the reply Actor posts
-- back in the same room. Kept with the person's data (account export and deletion).
CREATE TABLE actor_chat_asks (
    message_id bigint PRIMARY KEY,                                    -- Chat's message id (Events delivers at least once)
    requester text COLLATE "C" NOT NULL,                              -- user:usr_…
    username text NOT NULL,
    room jsonb NOT NULL,                                              -- { type: global } | { type: channel, channel_user_id, stream_id }
    task_id text COLLATE "C",                                         -- the task it became
    refused text,                                                     -- why no task was made (the reply says so)
    created_at text COLLATE "C" NOT NULL,
    replied_at text COLLATE "C",
    reply_attempts integer NOT NULL DEFAULT 0,
    next_attempt_at text COLLATE "C",
    reply_error text
);
CREATE INDEX actor_chat_asks_requester ON actor_chat_asks (requester, created_at DESC);
CREATE INDEX actor_chat_asks_created ON actor_chat_asks (created_at);
CREATE INDEX actor_chat_asks_waiting ON actor_chat_asks (created_at) WHERE replied_at IS NULL;
