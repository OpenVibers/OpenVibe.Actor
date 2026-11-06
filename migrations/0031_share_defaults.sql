-- phase: expand
-- Visibility step 2 (design 2026-11-06): the person's default audience for new runs, and one share row for every
-- run that already exists, Only me. New runs are registered as they are made (server/tasks/create.js); a run
-- without a row is still its owner's, because every read asks canView and a missing row answers no.
-- Repeating this file is a no-op. Expand-only.

CREATE TABLE IF NOT EXISTS actor_share_defaults (
    subject    text COLLATE "C" PRIMARY KEY,
    audience   text COLLATE "C" NOT NULL CHECK (audience IN ('public', 'link', 'people', 'private')),
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO shares (service, kind, resource_id, owner_subject, audience)
SELECT 'actor', 'run', id, jsonb_build_object('type', 'user', 'id', substring(requester from 6)), 'private'
FROM tasks
WHERE requester ~ '^user:usr_[0-9A-HJKMNP-TV-Z]{26}$'
ON CONFLICT (service, kind, resource_id) DO NOTHING;
