-- phase: expand
-- ADR-056: a task webhook may name a project secret (secret_ref) that signs its deliveries instead of the task's own
-- secret; OpenVibe.Network computes each signature, so Actor never holds the value. A delivery records the secret's
-- name and the project environment to look it up in, as they were when it was queued. Additive: an older release
-- ignores the columns and keeps signing with the task's secret.
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS secret_ref text COLLATE "C";
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS secret_env text COLLATE "C";
