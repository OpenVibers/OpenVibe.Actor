-- phase: expand
-- Actor v2, stage V2-10: a finished task the person offered as an OpenVibe.Bench case. Bench has no case intake yet
-- (checked 2026-10-30), so the offer is stored here until the handover stage posts it.
--
-- Only the task text and the final answer are kept, and only after the person confirmed the exact preview. Evidence,
-- files, memory and the trace stay on the task and are never copied here. The answer is stored as written.
--
-- owner is the person the task was for (user:usr_...), so the offer is exported and deleted with them
-- (server/identity/account-data.js). It goes with its task (ON DELETE CASCADE); withdraw deletes the row.
CREATE TABLE actor_bench_offers (
    task_id text COLLATE "C" PRIMARY KEY REFERENCES tasks (id) ON DELETE CASCADE,
    owner text COLLATE "C" NOT NULL,
    text text COLLATE "C" NOT NULL,
    answer text COLLATE "C" NOT NULL,
    offered_at text COLLATE "C" NOT NULL,
    status text COLLATE "C" NOT NULL DEFAULT 'offered' CHECK (status IN ('offered', 'sent'))
);
CREATE INDEX actor_bench_offers_owner ON actor_bench_offers (owner, offered_at);
