-- phase: expand
-- Plan §AB.44: an agent may save a provider key the person asked it to set up (setup.key, through a one-time grant on
-- OpenVibe.Network); it asks through the approval gate like every acting tool.
ALTER TABLE actor_approvals DROP CONSTRAINT IF EXISTS actor_approvals_kind_check;
ALTER TABLE actor_approvals ADD CONSTRAINT actor_approvals_kind_check CHECK (kind IN (
    'codes.task', 'actor.action', 'computer.run', 'computer.write', 'computer.input', 'computer.browser',
    'computer.desk', 'setup.key', 'robot.move', 'space', 'files.save', 'run.check', 'publish', 'post', 'send', 'install', 'routine',
    'money', 'skill.run', 'device.camera', 'device.location', 'device.notify'));
