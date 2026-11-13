-- phase: expand
-- Plan §Z.6 job 2: an agent may save a file in the person's OpenVibe.Download drive (files.save) and run a repository's
-- checks on a shared node (run.check); both ask through the approval gate like every acting tool.
ALTER TABLE actor_approvals DROP CONSTRAINT IF EXISTS actor_approvals_kind_check;
ALTER TABLE actor_approvals ADD CONSTRAINT actor_approvals_kind_check CHECK (kind IN (
    'codes.task', 'actor.action', 'computer.run', 'computer.write', 'computer.input', 'computer.browser',
    'computer.desk', 'robot.move', 'space', 'files.save', 'run.check', 'publish', 'post', 'send', 'install', 'routine',
    'money', 'skill.run', 'device.camera', 'device.location', 'device.notify'));
