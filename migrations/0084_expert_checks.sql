-- phase: expand
-- An Expert checked on its own examples (plan §AD.28 item 9, "a scorecard per version"): for each published version of
-- OpenVibe's own Experts, each of its examples (up to three) is answered from its instructions alone (one model call,
-- no tools) and graded against what the example says a good answer does, on five levels, through the Decisions API.
-- The Expert's page shows the mean and each answer with its grade. A new version is checked anew; an old version's
-- rows stay as they were. Expand-only: one new table.
CREATE TABLE IF NOT EXISTS expert_checks (
    blueprint_id text COLLATE "C" NOT NULL,
    version integer NOT NULL,
    example integer NOT NULL,
    ask text NOT NULL,
    good text NOT NULL,
    answer text NOT NULL,
    score numeric(3, 2) NOT NULL CHECK (score >= 1 AND score <= 5),
    level text NOT NULL,
    model text,
    cost_usd numeric(10, 6) NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (blueprint_id, version, example)
);
