-- phase: expand
-- HO12: a person's one-time device answer belongs to the approval and its asking run.
ALTER TABLE actor_approvals DROP CONSTRAINT IF EXISTS actor_approvals_kind_check;
ALTER TABLE actor_approvals ADD CONSTRAINT actor_approvals_kind_check CHECK (kind IN (
    'codes.task', 'actor.action', 'computer.run', 'computer.write', 'computer.input', 'computer.browser',
    'computer.desk', 'robot.move', 'space', 'publish', 'post', 'send', 'install', 'routine', 'money',
    'skill.run', 'device.camera', 'device.location', 'device.notify'));
ALTER TABLE actor_approvals ADD COLUMN IF NOT EXISTS answer jsonb;
ALTER TABLE actor_approvals ADD COLUMN IF NOT EXISTS device_wait_id text COLLATE "C";

-- An upload is usable only by the approval that received it. A declined request cannot reuse another photo.
CREATE TABLE IF NOT EXISTS actor_device_photos (
    approval_id text COLLATE "C" PRIMARY KEY REFERENCES actor_approvals(id) ON DELETE CASCADE,
    owner text COLLATE "C" NOT NULL,
    media_id text COLLATE "C" NOT NULL,
    created_at text COLLATE "C" NOT NULL
);

CREATE TABLE IF NOT EXISTS actor_device_notices (
    id text COLLATE "C" PRIMARY KEY,
    owner text COLLATE "C" NOT NULL,
    agent_id text COLLATE "C" NOT NULL,
    task_id text COLLATE "C" NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    created_at text COLLATE "C" NOT NULL
);
CREATE INDEX IF NOT EXISTS actor_device_notices_owner ON actor_device_notices(owner, created_at DESC);

-- Link heartbeats only while its Bot connection is live. Old rows are offline after 60 seconds.
CREATE TABLE IF NOT EXISTS actor_device_presence (
    owner text COLLATE "C" NOT NULL,
    device_id text COLLATE "C" NOT NULL,
    seen_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (owner, device_id)
);
