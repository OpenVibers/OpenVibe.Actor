-- phase: expand
-- Run settings and permission rules (plan 11c): one row per subject. subject 'site' holds the owner's rules for
-- everyone (files and network stay null there); a 'user:usr_…' row holds that person's default settings for their
-- runs and their own rules. rules is the whole ordered list (server/runtime/run-policy.js validates it; the last
-- matching rule wins, and a matching site rule is final). Written only through the API (server/http/run-policy-api.js).
CREATE TABLE actor_run_policies (
    subject text COLLATE "C" PRIMARY KEY,
    files text COLLATE "C" CHECK (files IS NULL OR files IN ('none', 'read', 'write')),
    network text COLLATE "C" CHECK (network IS NULL OR network IN ('off', 'on')),
    rules jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(rules) = 'array'),
    updated_by text COLLATE "C",
    updated_at text COLLATE "C" NOT NULL
);

-- The settings one run started with: { files, network, unattended } (unattended null, or the reason nobody waits:
-- 'schedule', 'agent', 'nobody'). Null on runs from before 11c, which read as the defaults.
ALTER TABLE tasks ADD COLUMN run_settings jsonb;
