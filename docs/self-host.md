# Run your own Actor

OpenVibe.Actor runs on your own server too: your tasks, your model, your data. A self-hosted Actor has one owner
(you), signs you in with a password, keeps everything in one process with its database on disk, and runs the
OpenVibe runtime on any OpenAI-compatible model you point it at: Ollama, llama.cpp, vLLM, or a provider you pay. It can
still use OpenVibe's public Search and Tools anonymously, or stay fully offline.

## Five minutes with Docker

```sh
git clone https://github.com/OpenVibers/OpenVibe.Actor && cd OpenVibe.Actor
npm ci --omit=dev
npm run selfhost:init -- --name you --url http://localhost:4950
docker compose -f docker-compose.selfhost.yml --profile ollama up -d
docker compose -f docker-compose.selfhost.yml exec ollama ollama pull qwen2.5:7b-instruct
```

Open http://localhost:4950/auth/login and sign in with the password `selfhost:init` printed. It is shown only once.
Then give Actor a task on `/console`, or call the API with your token:

```sh
curl -s http://localhost:4950/api/v1/tasks -H "Authorization: Bearer $ACTOR_OWNER_TOKEN" \
  -H 'Content-Type: application/json' -d '{"task": "Explain what a mutex is in two sentences."}'
```

Without Docker: `npm ci --omit=dev`, then `node --env-file=.env.selfhost server/index.js`. Change `DATA_DIR` to a folder
you own first.

## What `selfhost:init` writes

`.env.selfhost`, mode 600, never overwritten. Keep it private.

| Setting | What it is |
|---|---|
| `ACTOR_SELF_HOSTED=1` | the self-hosted mode |
| `ACTOR_OWNER_NAME`, `ACTOR_OWNER_SUBJECT` | you; the subject is a `usr_…` id your tasks are filed under |
| `ACTOR_OWNER_PASSWORD_HASH` | your password, scrypt-hashed (set `ACTOR_INIT_PASSWORD` to choose it) |
| `ACTOR_OWNER_TOKEN` | your API token (`Authorization: Bearer …`) |
| `ACTOR_SESSION_SECRET` | signs your sign-in cookie (30 days) |
| `BASE_URL`, `COOKIE_SECURE` | the address you open; secure cookies when it is https |
| `DATA_DIR` | where the database lives (PGlite in `DATA_DIR/pglite`); set `DATABASE_URL` and `DATABASE_DIRECT_URL` for PostgreSQL instead |
| `ACTOR_RUNTIME_URL`, `ACTOR_RUNTIME_MODEL`, `ACTOR_RUNTIME_API_KEY` | the runtime's model: any OpenAI-compatible `/v1` endpoint |
| `ACTOR_RUNTIME_INPUT_USD_PER_MTOK`, `…_OUTPUT_…` | its price per million tokens (0 on your own hardware), used for budgets and costs |
| `ACTOR_RUNTIME_OPENVIBE_CLIENT_ID`, `…_CLIENT_SECRET` | instead of a key: an OpenVibe app, for OpenVibe's hosted models (below) |
| `ACTOR_SEARCH_URL`, `ACTOR_TOOLS_URL` | OpenVibe's public Search and Tools, used anonymously; empty means the runtime is not offered them |
| `ACTOR_DEEPSEEK_API_KEY`, `ACTOR_OPENAI_API_KEY` | optional: more agents, and another model family to check answers |
| `ACTOR_FREE_*`, `ACTOR_MAX_COST_USD_PER_DAY` | your own daily limits |

## OpenVibe's hosted models (burst)

Your Actor can run its runtime on OpenVibe's hosted models (`ai.openvibe.services`) instead of, or until you have, a
model of your own. Your OpenVibe project pays for the runs and sees them; nothing else about your Actor changes.

1. Make an app in one of your OpenVibe projects, signed in to OpenVibe (your Network token as `Authorization: Bearer`):
   `POST https://openvibe.network/api/v1/projects/<project>/apps` with `{ "name": "My Actor", "environment": "sandbox" }`.
   The answer has the app's `id` (its client id, `app_…`) and `credential.client_secret`, shown once.
2. Give it `ai.app.run`: `POST https://openvibe.network/api/v1/projects/<project>/apps/<app>/grants` with
   `{ "capability": "ai.app.run" }`. A sandbox app gets it at once and runs on OpenVibe's free and local capacity only;
   a production app's allowance is set by OpenVibe.
3. Set, and restart:

   ```
   ACTOR_RUNTIME_URL=https://ai.openvibe.services/v1
   ACTOR_RUNTIME_MODEL=default
   ACTOR_RUNTIME_OPENVIBE_CLIENT_ID=app_…
   ACTOR_RUNTIME_OPENVIBE_CLIENT_SECRET=…
   ```

- **Tokens.** The runtime asks OpenVibe for the app's five-minute token itself: a new one shortly before the last one
  expires, and once more if the model answers 401. Revoking the app or its credential on OpenVibe stops it within
  five minutes.
- **Models and cost.** OpenVibe's router picks the model for `default` by price and health, and only from providers
  that support tool calls when the runtime sends tools. Each call's cost is what OpenVibe's answer says it cost
  (`x_openvibe.cost_usd`), so leave the `…_USD_PER_MTOK` prices at 0.
- **What it is not.** The app acts for your project, not as a person. Your robots and computers on OpenVibe.Bot and
  coding on OpenVibe.Codes still need a person's OpenVibe sign-in, which a self-hosted Actor does not have yet.

## How it differs from openvibe.actor

- **Sign-in.** One owner and a password, not OpenVibe.Network. The API takes only your token; OpenVibe account tokens are
  refused.
- **Models.** The OpenVibe runtime runs on your model and is listed as user-owned, at your price.
  - **Checking.** Every answer is checked before you see it. With only your model, it checks its own answers, and the
    task says it was a same-family check. Add an OpenAI or DeepSeek key for a check from another family.
  - **Tools.** The runtime acts through OpenVibe Search and Tools when those URLs are set. A small model may use tools
    less well than DeepSeek; pick one that supports tool calls (Qwen 2.5 7B and up, Llama 3.1 8B and up).
- **What is off.** Your robots and computers on OpenVibe.Bot, coding on OpenVibe.Codes, asking from OpenVibe chat, task
  webhooks signed by Network, and account export through Network all need an OpenVibe service identity.
- **Data.** Tasks, their logs and your daily spend stay in your database. Nothing is sent to OpenVibe except the
  Search and Tools calls the runtime makes, when you leave those URLs set, and the runtime's model calls when it runs
  on OpenVibe's hosted models.

## Updating

`git pull`, then `docker compose -f docker-compose.selfhost.yml up -d --build`. Migrations apply at start, and your data
stays in the `actor-data` volume.

## Security notes

- **Exposure.** It listens on 127.0.0.1:4950 in the compose file. Put it behind your own TLS proxy before exposing it,
  and set `BASE_URL` to the https address so cookies are secure.
- **Secrets.** The password is stored only as a scrypt hash. The session cookie is HMAC-signed and httpOnly. The API
  token is compared in constant time.
- **Limits.** Sign-in attempts are limited (60 per 15 minutes per address).
