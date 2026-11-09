-- phase: expand
-- The Link provider replaces the old paired-machine provider in existing choices.
-- A later contract migration removes own:node from the check after all readers use Link.
ALTER TABLE actor_model_prefs DROP CONSTRAINT IF EXISTS actor_model_prefs_choice_check;
ALTER TABLE actor_model_prefs ADD CONSTRAINT actor_model_prefs_choice_check
    CHECK (choice IN ('auto', 'openvibe', 'own:openai', 'own:anthropic', 'own:deepseek', 'own:google', 'own:openrouter', 'own:mistral', 'own:node', 'own:link'));
UPDATE actor_model_prefs SET choice = 'own:link' WHERE choice = 'own:node';
