-- phase: expand
-- Plan §AD.37: the spare_usage tool changes the person's spare-usage list on OpenVibe.Codes (what it holds starts coding
-- tasks on their machines when a plan is about to reset); it asks through the approval gate as the kind `codes.spare`.
ALTER TABLE actor_approvals DROP CONSTRAINT IF EXISTS actor_approvals_kind_check;
ALTER TABLE actor_approvals ADD CONSTRAINT actor_approvals_kind_check CHECK (kind IN (
    'codes.task', 'codes.spare', 'actor.action', 'computer.run', 'computer.write', 'computer.input', 'computer.browser',
    'computer.desk', 'setup.key', 'robot.move', 'space', 'code', 'files.save', 'run.check', 'publish', 'post', 'send', 'install', 'routine',
    'money', 'skill.run', 'device.camera', 'device.location', 'device.notify'));
