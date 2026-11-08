-- phase: expand
-- HO8 step 3 (ADR-060): a sandbox skill's code is pinned in the listing.
--
-- Each code resource of an actor.skill@2 document that runs in a sandbox is stored as a private OpenVibe.Media
-- object (Actor's tenant). CODE holds, per code resource, { name, media_id, sha256 }: the resource path a tool's
-- entry names, the Media object the registry stored its bytes under, and the sha256 of those bytes. The bytes
-- that run are the bytes that were scanned: a later run names exactly these ids and hashes, so a changed
-- object or a changed document cannot run. A prompt-only listing leaves CODE null.
ALTER TABLE actor_skill_listings ADD COLUMN IF NOT EXISTS code jsonb;

-- The document's JSON text, in the order it was written. JSONB reorders object keys, and a skill's integrity hash
-- covers its canonical JSON, nested `args` objects included, so the published text (not a re-serialized jsonb value)
-- is what every listing answers with: a later read hashes back to the same integrity block.
ALTER TABLE actor_skill_listings ADD COLUMN IF NOT EXISTS skill_text text;

-- HO8's kind: running a skill's code in a sandbox (ADR-060). The approval table's check widens with the code's list
-- (agents/kinds.js), and every old row stays valid.
ALTER TABLE actor_approvals DROP CONSTRAINT IF EXISTS actor_approvals_kind_check;
ALTER TABLE actor_approvals ADD CONSTRAINT actor_approvals_kind_check CHECK (kind IN (
    'codes.task', 'actor.action', 'computer.run', 'computer.write', 'computer.input', 'computer.browser',
    'computer.desk', 'robot.move', 'space', 'publish', 'post', 'send', 'install', 'routine', 'money', 'skill.run'));
