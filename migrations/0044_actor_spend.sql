-- phase: expand
-- HO7 (an agent that can spend): a weekly allowance per agent, in Vibes, and the payments made against it.
--
-- The allowance lives on the agent (spend_weekly_vibes): 0 means off, and an agent with no allowance is never offered
-- the spending tool at all. The payments are their own rows (actor_spends): one claim per approval, reserved before
-- Billing is called and settled when it answers, so the week can be counted and the person can see every tip their
-- agent sent. A payment Billing refused is kept as a failed attempt: it never counts against the allowance and never
-- shows as a payment.
--
-- Expand-only: a new column with a default and a new table. Nothing renamed, nothing dropped, so the previous
-- release keeps writing rows and an old row reads as "no allowance".
ALTER TABLE actor_agents
    ADD COLUMN IF NOT EXISTS spend_weekly_vibes integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS spend_weekly_set_at text;

CREATE TABLE IF NOT EXISTS actor_spends (
    id          text COLLATE "C" PRIMARY KEY,          -- spn_<ULID>
    owner       text COLLATE "C" NOT NULL,             -- user:usr_… the person whose Vibes paid
    agent_id    text COLLATE "C" NOT NULL,             -- agt_… the agent that asked
    approval_id text COLLATE "C",                      -- the approval it was paid at (the idempotency key)
    to_subject  text COLLATE "C" NOT NULL,             -- usr_… the creator who receives it
    to_label    text COLLATE "C",                      -- what the person read on the card (a name or a handle)
    amount      integer NOT NULL CHECK (amount > 0),   -- Vibes (bits): whole Vibes, never a fraction
    reason      text COLLATE "C",                      -- the person's own words for it
    target      jsonb,                                 -- what the money is for (a creator's page, a channel …)
    state       text COLLATE "C" NOT NULL CHECK (state IN ('paying', 'paid', 'failed')),
    txn_id      text COLLATE "C",                      -- Billing's transaction id
    error       text COLLATE "C",                      -- why a refusal did not pay
    week_start  text COLLATE "C" NOT NULL,             -- the allowance week it counts in (a Monday, UTC)
    created_at  text COLLATE "C" NOT NULL
);
-- One live claim per approval: a second click can never pay twice, even if two clicks race. A failed attempt is not
-- live, so the person may try again after topping up their Vibes.
CREATE UNIQUE INDEX IF NOT EXISTS actor_spends_approval ON actor_spends (approval_id) WHERE state IN ('paying', 'paid');
CREATE INDEX IF NOT EXISTS actor_spends_agent ON actor_spends (owner, agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS actor_spends_week ON actor_spends (owner, agent_id, week_start) WHERE state = 'paid';
