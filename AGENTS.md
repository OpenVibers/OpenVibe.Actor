# AGENTS.md — OpenVibe.Actor

## Project overview

OpenVibe's own general agent and the router for agent work: a task in plain words is sorted (answer,
lookup, research, live web search or code), placed on the best agent for it, run while its steps
stream, checked by a model of another family, then delivered with its cost and the reason it went
where it did. Node.js/Express, PostgreSQL (`ov_actor`), CommonJS, **no build step**.

- Service id `actor`, port `4950`, origin `https://openvibe.actor`, unit `openvibe-actor.service`,
  release root `/opt/openvibe.actor`; live on openvibe-ovh.
- Design: plan T17 and ADR-044 (`openvibe-contracts`). Actor is also the front desk of the one agent
  system: it can delegate coding to Codes, a robot to Bot and a machine's agent to Link.

## What it owns

- Tasks, their event logs and daily spend (`migrations/0001_tasks.sql`); tasks are kept 30 days, then
  pruned with their events. Nothing stored is a credential, a key or a token.
- The agent catalog and its human-typed rate cards; the routing policy over them (placement itself is
  `openvibe-sdk/placement`).
- An agent's **voice** as a file (`actor.voice@1`, `server/agents/voice.js`), its integrity hash and
  public shares at `/voices/<id>`.
- The pages (`/`, `/agents`, `/docs`, `/tasks`, `/tasks/:id`, `/updates`), the console
  (`/console`), the task API, chat asks (`@actor` in Chat), triggers/cron, webhooks, agent mail,
  connections (MCP/A2A), skills, memory, sharing, task artefacts and the `actor.task.*` events.
- Request telemetry (`telemetry_samples`, 14 days; route templates only, never raw URLs).

Not owned: coding runs (Codes), execution sandboxes/browsers/desktops (Run/Link), accounts, apps and
grants (Network/Services), the tools (Tools), search (Search), the model providers' routing (AI when
its router is on).

## Who calls it, and whom it calls

- Callers: people in the browser; apps, agents and services with a Network service token audience
  `openvibe.actor` and the route's capability; a first-party `svc:` acting for a person with
  `X-OV-Subject` (e.g. Watch's actor-task action); OpenVibe.Chat (`@actor <task>`).
- Depends on (all base URLs in [server/config.js](server/config.js)):
  - **Network** — OAuth2+PKCE (client `actor`), JWKS, account export/deletion pushes.
  - **Search** (`ACTOR_SEARCH_URL`) — `search_openvibe` anonymous; `search_web` as Actor's principal
    with `search.query.delegate` and `X-OV-Subject`, so paid steps count against the person.
  - **Tools** (`ACTOR_TOOLS_URL`) — catalog, run API, page reader, as an anonymous caller.
  - **Bot** (`ACTOR_BOT_URL`, default `http://127.0.0.1:4630`) — the person's robots and computers
    (`bot.robot.*`, `bot.computer.*`), owner-only and only where the owner turned the switch on.
  - **Events** (`ACTOR_EVENTS_URL`) — account-data subscriptions, `chat.message.created`.
  - **Chat** (`ACTOR_CHAT_URL`, default `http://127.0.0.1:4400`) — asks and replies.
  - **AI** (`ACTOR_AI_ROUTER=1` in production) — every model call is an `ai.complete` run with
    `on_behalf_of` the task's person; each tier names an AI policy (`ACTOR_AI_MODEL_*`). With the
    router off, a self-hosted Actor uses DeepSeek/OpenAI/a local server directly.
  - PostgreSQL and Valkey; `pdftotext` for PDF attachments.

## How a task runs

1. **Sort** — [server/agents/classify.js](server/agents/classify.js) (cheap model, or a free heuristic
   in private mode).
2. **Route** — [server/agents/router.js](server/agents/router.js) over
   [server/agents/catalog.js](server/agents/catalog.js): hard requirements first (capability, private
   trust, health, budget), then the mode's objective (cheapest/balanced/best/fastest/private). The
   result is a `platform.placement-result@1` stored as the explanation.
3. **Run** — [server/agents/adapters.js](server/agents/adapters.js); steps stream as events; model
   calls and searches are metered at once, so a cancelled task still costs what it used.
4. **Check** — [server/agents/check.js](server/agents/check.js): a model of another family reads the
   answer (DeepSeek ↔ OpenAI). In private mode the open model checks itself and the task says so. An
   answer that cannot be checked is never delivered.
5. **Deliver or hand on** — [server/tasks/engine.js](server/tasks/engine.js): a pass returns the
   result, cost and explanation; an error or failed check hands to the next eligible agent (at most
   two), appending each placement to the explanation.

## Repository map

- **Entry:** [server/index.js](server/index.js) — `createApp()`, HTTP listen, status reconciliation;
  `createLifecycle` stops tasks and leaves their rows open for checkpoint resume.
- **App:** [server/app.js](server/app.js) — helmet/CSP, rate limits, `/auth`, `/internal/events`,
  `/shared`, `/api/v1` (tasks, resources, fabric), `/api`, pages, console, chat/agent/memory pages.
- **Config:** [server/config.js](server/config.js), [server/ai-catalog-config.js](server/ai-catalog-config.js).
- **Database:** [server/db.js](server/db.js), [server/tasks/store.js](server/tasks/store.js); schema in
  [migrations/](migrations/).
- **Tasks:** [server/tasks/](server/tasks/) — `engine.js`, `create.js`, `stream.js`, `webhooks.js`.
- **Agents/runtime:** [server/agents/](server/agents/), [server/runtime/](server/runtime/) (loop,
  models, checkpoints, subagent, evidence, tools, stats, artifacts).
- **Auth:** [server/auth/keys.js](server/auth/keys.js), [server/auth/sso.js](server/auth/sso.js),
  [server/http/principal.js](server/http/principal.js).
- **HTTP/pages:** [server/http/](server/http/) — `api.js`, `pages.js`, `chat-pages.js`,
  `agent-pages.js`, `console-pages.js`, `memory-pages.js`.
- **Integrations:** [server/chat/](server/chat/), [server/triggers/](server/triggers/),
  [server/mail/](server/mail/), [server/connections/](server/connections/).
- **Self-host:** [scripts/selfhost-init.js](scripts/selfhost-init.js), [docs/self-host.md](docs/self-host.md),
  [docker-compose.selfhost.yml](docker-compose.selfhost.yml), [Dockerfile](Dockerfile).

## Commands

```bash
npm install
npm run dev                       # http://localhost:4950 (agents without keys are unavailable)
npm start                         # node server/index.js
npm test                          # every test/*.test.js on temp PGlite, mock Network/Events/Media
npm run test:pg                   # same suite on PostgreSQL (ACTOR_TEST_STORE=pg)
npm test -- tasks                 # filter by file name; --strict makes a skip fail
npm run selfhost:init             # owner subject, password hash, token, session secret
ov test                           # the harness's sharded run of what the change reaches
```

## Auth and capabilities

- A person acting for themself needs no capability. App/agent/service tokens for audience
  `openvibe.actor` need the route's capability: `actor.task.create`, `actor.task.read`,
  `actor.task.list`; `actor.agent.read` covers the public catalog/dry run.
- A **first-party `svc:`** may act for a person named in `X-OV-Subject`; the task is the person's
  (allowance, list, export, deletion) and records the service as `via`; it can read/list/cancel only
  the tasks it started. A developer app or an agent may never name a person (`403 subject.not_delegated`).
- Sessions are HttpOnly cookies from Network SSO; a FedCM assertion or an app/service token is never a
  session. Never read identity from a body or a query.

## Frontend loading model

Server-rendered pages and forms, progressively enhanced by no-build scripts under
[public/js/](public/js/); there is no SPA framework, bundler or transpiler. `openvibe-shared` supplies
the Frame, shell, showcase and `/shared/*` (served from the pinned node_modules). The home page has
size budgets (`test/home.test.js`, `test/asset-cache.test.js`); CSP is set in
[server/app.js](server/app.js).

## Deploy

`sudo ovhost deploy actor` (git checkout at `/opt/openvibe.actor`, unit `openvibe-actor.service` on
`127.0.0.1:4950`, env `/etc/openvibe/actor.env`, database `ov_actor` on the data role); nginx
[deploy/nginx/openvibe.actor.conf](deploy/nginx/openvibe.actor.conf) installed with `ov-vhost-install`,
with the task event stream unbuffered. Rollback is automatic when `/api/ready` fails. **A stop or a
deploy marks running tasks `actor.task.interrupted`; they are never re-run behind the person's back.**

## Tests

`npm test` runs each `test/*.test.js` in its own process on PGlite with in-process Network/Events/
Media mocks and stand-in providers. The important ones: `tasks.test.js` (end-to-end, routing, check,
hand-off, private mode, budgets, idempotency, cancel, stream, visibility), `contracts.test.js`
(released manifest/capabilities match the routes), `account-data.test.js`, `caller-limits.test.js`,
`security-ssrf.test.js`, `security-secrets.test.js`, `security-session.test.js`. `ov test` runs the same.

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons; factories with injectable config/db/clock/
  fetch/log; domain logic in `server/tasks/`, `server/agents/`, `server/runtime/`, HTTP in `server/http/`.
- Contracts and ids come from `openvibe-contracts`; errors are problem+json with stable codes and
  request ids. No secret in a response, an event or a log.
- Rate cards are typed in by a person, with the provider's page and the date checked; a model never
  writes a price.
- For self-hosted deployments the owner/secret check is deliberate; do not loosen `checkSelfHosted`.

## Pitfalls

- **Actor never fetches a URL from a task or a model.** Tools' own SSRF guard decides what a tool may
  reach; the same applies to `read_page`. Keep outbound calls to configured bases.
- **Private mode must not send the text outside OpenVibe** — including the classifier and the check.
- **An unchecked answer is never delivered.** With the AI router the check is one family, and the
  verdict says so; do not silently drop the check.
- **`@actor` asks are public:** they may use public tools only, and the engine refuses a robot,
  computer or coding task (`actor.task.not_public`). Limits: 5/hour per person, 60 overall.
- **`X-OV-Subject` is only for first-party services**; apps/agents cannot delegate.
- **Budgets are hard** and metered per call; a cancelled task still charges what it used, and the free
  tier is checked before any paid call.
- **Interrupted tasks are not re-run**; never "retry" a person's task automatically after a deploy.
- **Self-hosted boot refuses** without `ACTOR_OWNER_SUBJECT`, `ACTOR_OWNER_PASSWORD_HASH`,
  `ACTOR_OWNER_TOKEN` (32+) and `ACTOR_SESSION_SECRET` (32+).
- **A shared voice's author is only a claim**; the integrity hash proves the file was not edited, not
  who wrote it.

## Documentation

- [README.md](README.md) — the full product, agents, money, API, acceptance and threats.
- [docs/one-engine.md](docs/one-engine.md) — the shared engine with Codes and Run.
- [docs/agent-runs.md](docs/agent-runs.md), [docs/task-view.md](docs/task-view.md).
- [docs/personal-actor.md](docs/personal-actor.md), [docs/self-host.md](docs/self-host.md),
  [docs/work-fabric.md](docs/work-fabric.md).
- ADR-044 in OpenVibe.Contracts is the binding design.
