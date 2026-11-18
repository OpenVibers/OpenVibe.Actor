-- phase: expand
-- The owner, 11-15: "instead of having vibe, the chatbot, we just have actor, or like at least that's the default name
-- for it. You can rename it from that, but instead of my actor": a person's Actor and their first agent (is_vibe) are
-- one agent called Actor until they name it. A name a person chose is kept; only the old defaults change.
ALTER TABLE actors ALTER COLUMN name SET DEFAULT 'Actor';
UPDATE actors SET name = 'Actor' WHERE name = 'My Actor';
UPDATE actor_agents SET name = 'Actor' WHERE is_vibe AND name = 'Vibe';
