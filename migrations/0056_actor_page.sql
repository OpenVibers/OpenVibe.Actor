-- phase: expand
ALTER TABLE actors ADD COLUMN adult_opt_in boolean NOT NULL DEFAULT false;
ALTER TABLE actor_day_goals ADD COLUMN schedule jsonb;
ALTER TABLE actor_day_goals ADD COLUMN do_now boolean NOT NULL DEFAULT false;
ALTER TABLE actor_day_goals ADD COLUMN brain_override text;
ALTER TABLE actor_day_asks ADD COLUMN session_id text;
ALTER TABLE actor_day_asks ADD COLUMN evidence jsonb;
ALTER TABLE actor_day_messages ADD COLUMN in_prompt boolean NOT NULL DEFAULT false;
ALTER TABLE actor_day_messages ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]';
CREATE TABLE actor_day_earnings (
 id text PRIMARY KEY, actor_id text NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
 owner text NOT NULL, text text NOT NULL, usd double precision NOT NULL CHECK (usd > 0), created_at text NOT NULL
);
