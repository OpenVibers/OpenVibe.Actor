-- phase: expand
-- Plan L55 C3: a person may run their tasks on a model on their own computer ('own:node': OpenVibe.AI's "Your
-- computer", through their OpenVibe Node; no key). The choice list widens by one; every row that was valid stays
-- valid, and the code before this one never writes the new value.
ALTER TABLE actor_model_prefs DROP CONSTRAINT IF EXISTS actor_model_prefs_choice_check;
ALTER TABLE actor_model_prefs ADD CONSTRAINT actor_model_prefs_choice_check
    CHECK (choice IN ('auto', 'openvibe', 'own:openai', 'own:anthropic', 'own:deepseek', 'own:google', 'own:openrouter', 'own:mistral', 'own:node'));
