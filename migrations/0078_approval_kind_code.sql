-- phase: expand
-- Plan §AD.10 step 1: the agent changes the person's own code on OpenVibe.Git (makes a repository, commits, opens a
-- change: the git_* tools); it asks through the approval gate like every acting tool, as the kind `code`.
ALTER TABLE actor_approvals DROP CONSTRAINT IF EXISTS actor_approvals_kind_check;
ALTER TABLE actor_approvals ADD CONSTRAINT actor_approvals_kind_check CHECK (kind IN (
    'codes.task', 'actor.action', 'computer.run', 'computer.write', 'computer.input', 'computer.browser',
    'computer.desk', 'setup.key', 'robot.move', 'space', 'code', 'files.save', 'run.check', 'publish', 'post', 'send', 'install', 'routine',
    'money', 'skill.run', 'device.camera', 'device.location', 'device.notify'));
