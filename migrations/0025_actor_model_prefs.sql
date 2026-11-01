-- phase: expand
-- Plan L55 C3: the model a person chose for their tasks (the owner, 2026-11-01: "use your own API keys, or
-- OpenVibe's… choosing the model per chat"). server/runtime/model-prefs.js.
--
-- requester is the person the choice belongs to (user:usr_...), as tasks.requester, so the row is exported and
-- deleted with the person (server/identity/account-data.js). choice is 'auto' (Actor decides, as today), 'openvibe'
-- (OpenVibe's own keys, through OpenVibe.AI) or 'own:<provider>' (the person's own key for that provider, which
-- lives sealed in OpenVibe.AI's vault and never in Actor). model is the model id they picked, or nothing:
-- OpenVibe.AI then routes the call. Nothing here is a secret: no key, token or credential is stored.
CREATE TABLE actor_model_prefs (
    requester text COLLATE "C" PRIMARY KEY,
    choice text COLLATE "C" NOT NULL CHECK (choice IN ('auto', 'openvibe', 'own:openai', 'own:anthropic', 'own:deepseek', 'own:google', 'own:openrouter', 'own:mistral')),
    model text COLLATE "C",
    updated_at text COLLATE "C" NOT NULL
);
