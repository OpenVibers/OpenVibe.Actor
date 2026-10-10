-- phase: expand
-- OpenVibe.Actor: a task a first-party service created for a person (X-OV-Subject, e.g. OpenVibe.Watch's actor-task
-- action) belongs to that person (requester user:usr_…) and records the service here (`service:watch`). NULL: the
-- requester asked for it themself. A delegated caller sees and cancels only the tasks it started.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS via TEXT;
