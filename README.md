# OpenVibe.Actor

> Your agent for everything: give a task in plain words, and Actor sends it to the best agent for it — OpenVibe's own, acting through every OpenVibe service, or another platform's — has a second model check the answer, and shows you what it cost and why. Like OpenRouter, for agents.

**Status:** alpha. Public at `https://openvibe.actor` (openvibe-ovh, unit `openvibe-actor` on 127.0.0.1:4950 behind nginx). See [STATUS.json](STATUS.json) for exactly what works and what does not.
**Domain:** `openvibe.actor` · **Port:** 4950 · **Service id:** `actor`
**Plan:** T17 (owner direction 2026-10-08: OpenVibe's own general agent, competing with the big labs' agents while able to use theirs; an OpenRouter for agents; cheap self-hosted browser and desktop agents). Decisions: [ADR-044](https://github.com/OpenVibers/OpenVibe.Contracts/blob/main/docs/adr/ADR-044-actor-runtime.md) (proposed).
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

Actor is OpenVibe's own general agent and the router for agent work: it takes a task in plain words, sends it to the best agent system for it, streams the steps, has a model of another family check the answer, and gives back the result with its cost and the reason it went where it did. People use it in the browser at openvibe.actor with their OpenVibe.Network account. Apps, agents and services use the same API with a Network token for audience `openvibe.actor` and an `actor.task.*` grant.

## How a task runs

1. **Sort it** ([server/agents/classify.js](server/agents/classify.js)): an answer, a lookup (a domain, address or site), research (pages it names, or OpenVibe's content), a live web search, or code. A cheap model decides, or a free heuristic in private mode, so the text never leaves OpenVibe there.
2. **Route it** ([server/agents/router.js](server/agents/router.js)): `openvibe-sdk/placement` over the agent catalog. Hard requirements come first: the task class's capability, the trust private mode demands, each agent's health, and the budget as a cost ceiling. Then the mode's objective: cheapest, balanced (the default), best (high-quality agents first), fastest, or private (first-party only). The answer is a `platform.placement-result@1`, stored on the task as its explanation.
3. **Run it** ([server/agents/adapters.js](server/agents/adapters.js)): the agent works while its steps stream as events. Every model call and web search is metered at once at the published rate card, so the cost is true even if the task is cancelled half-way.
4. **Check it** ([server/agents/check.js](server/agents/check.js)): a model of another family reads the answer. DeepSeek's answers are checked by OpenAI's smallest model, and OpenAI's by DeepSeek. In private mode the open model checks itself, and the task says so. An answer that cannot be checked is never delivered.
5. **Deliver or hand on** ([server/tasks/engine.js](server/tasks/engine.js)): a passed check gives the result (the answer, its sources, the agent and model, the check), the cost and the explanation. An agent error or a failed check sends the task to the next eligible agent (at most two), with each placement appended to the explanation.

## The agents ([server/agents/catalog.js](server/agents/catalog.js))

| Agent | Kind | Can do | Trust | Price |
|---|---|---|---|---|
| OpenVibe runtime | openvibe-runtime | answer, lookup, research, robot | external (the model runs at DeepSeek) | DeepSeek Flash, $0.30 in / $1.20 out per 1M tokens (peak; off-peak is half, Actor charges peak) |
| OpenAI agent | agent-platform | answer, research, web | external | gpt-5-mini, $0.25 / $2.00 per 1M, plus $0.01 a web search |
| Open model on OpenVibe | open-model | answer | first-party | free (OpenVibe's own server; `openvibe-llm` on the host) |
| OpenVibe.Codes | codes | code | first-party | listed, not hosted yet: coding runs need OpenVibe.Run sandboxes; use `openvibe-codes` on your machine |

The runtime acts only through OpenVibe's public APIs ([server/agents/tools.js](server/agents/tools.js)):
- OpenVibe.Search: content across the network;
- OpenVibe.Tools' catalog and run API: DNS, mail records, certificates, headers, WHOIS, conversions and more, limited to tools any anonymous caller may run;
- the Tools page reader (`read`): a web page as text.

Actor itself never fetches a URL from a task or a model; Tools' own SSRF guard decides what a tool may reach.

Rate cards are typed in by a person from each provider's price page, with the page and the day it was checked, and are never written by a model.

## API

| Route | Capability | |
|---|---|---|
| `POST /api/v1/tasks` | `actor.task.create` | `actor.task-create-request@1` → `platform.task@1` (201, queued; with `webhooks`, the answer carries `webhook_secret` once) |
| `GET /api/v1/tasks/:id` | `actor.task.read` | the task |
| `GET /api/v1/tasks/:id/events` | `actor.task.read` | server-sent events, `actor.task-event@1`, resumable with `Last-Event-ID` |
| `POST /api/v1/tasks/:id/cancel` | `actor.task.create` | stop it |
| `GET /api/v1/tasks` | `actor.task.list` | `actor.task-list-result@1` |
| `GET /api/v1/me/agents` | public | `actor.agent-list-result@1` |
| `GET/POST /api/v1/me/agents` (signed in) | `actor.agent.manage` for a token | list or create your personal agents; signed-out GET keeps the public catalog |
| `GET/PATCH/DELETE /api/v1/me/agents/:id` | `actor.agent.manage` for a token | read, edit or delete one personal agent |
| `GET /me/approvals`, `GET/POST /me/approvals/:id` (signed in) | the person | the approval inbox ([server/agents/approvals.js](server/agents/approvals.js)): when one of the person's own agents runs while they are away and would start a coding task on their machine (the `codes` agent), the run asks instead and ends with a link; nothing reaches Codes until the person approves, which starts it as their own task (declining runs nothing; a request expires after 7 days). In the account export (`approvals.json`) and deletion. |
| `GET/POST /api/v1/me/agents/:id/memory`, `PATCH/DELETE /api/v1/me/agents/:id/memory/:mem`, `DELETE /api/v1/me/agents/:id/memory` | `actor.agent.manage` for a token | control its memory |
| `POST /api/v1/me/agents/:id/run`, `GET /api/v1/me/agents/:id/runs` | `actor.agent.run` for a token | run now or list its tasks |
| `POST /me/agents/:id/suggestions/:pid` (signed in) | the person | what the agent suggested adding to its instructions (a run that passed its check may end with `IMPROVE: <line>`; at most three wait, the same line once), under "Suggestions from your agent" on its page: apply adds the line, dismiss drops it, undo restores the instructions while they are as it left them. In the account export (`agent-suggestions.json`) and deletion. The API routes follow once `actor.agent.manage` lists them (contracts). |
| `POST /api/v1/route` | public | dry run: which agent and why (heuristic class; nothing runs or is charged) |
| `GET /api/v1/resources` | `actor.resource.read` (service token) | `common.resource-list-result@1` for `actor.task`; filters: `project`, `kind`, `cursor`, `limit` |
| `GET /api/v1/resources/:ovrn` | `actor.resource.read` (service token) | one `common.resource-summary@1` for a project-owned task |
| `POST /api/v1/resources/control` | `actor.resource.control` (service token) | `common.resource-control-request@1` → `-result@1`: `stop` cancels a task (queued: done at once; running: pending until its step returns) |

The resource index is for OpenVibe.Services on loopback and is blocked at the public nginx vhost. It lists task summaries under the `actor.task` kind; only a service token with `actor.resource.read` can read it. A task without a project has no OVRN and cannot be fetched by name. The control route acts for the person in `on_behalf_of`: the person who asked for the task, or an admin or owner of its project (asked of Network with `network.project.member.read`), so a project's admins can stop what its apps started. Repeats with the same `idempotency_key` return the first answer (`actor_control_log`).

**Who can call it:**
- **A person:** their Network token as a Bearer, or this site's session. A write made with the session must come from openvibe.actor itself (fetch metadata or Origin).
- **An app, agent or service:** a token for audience `openvibe.actor` that holds the route's capability, granted on OpenVibe.Services. Its tasks belong to the token's project.

**What a caller can see:** a task is visible only to its requester, or to tokens of its project. Anyone else gets 404, the same answer as a task that doesn't exist.

**Webhooks:** a task may register up to 8 https endpoints, each with the state changes to deliver (`webhooks: [{ url, events }]`, the names of `state`).
- **Signing:** the answer that creates the task carries `webhook_secret`, minted for that task. It is in no read or list, never exported, and erased once the task has ended and its deliveries are done. Each delivery is `actor.task-webhook@1` (`{ type: "actor.task.state", delivery_id, state, task }`, the task as it was then), signed like an Events delivery (`X-OpenVibe-Timestamp` + `X-OpenVibe-Signature-V2`), so a receiver checks it with openvibe-sdk/events `verifyDeliveryV2(rawBody, headers, secret)`. The delivery id stays the same across retries; dedupe on it.
- **Outcomes:** 2xx is delivered; 410, or a URL refused at send time, ends the delivery; anything else is retried after 10 s, 1 min, 5 min, 30 min, 2 h, 6 h and 12 h, then fails.
- **Where Actor may connect:** a webhook URL is the one address a caller chooses (`server/net/webhook-post.js`): https on port 443 or 8443, no credentials, public addresses only. It is checked at creation (`actor.webhook.refused`) and again at send time through openvibe-shared/egress, so a name that later resolves to a private address is refused. Redirects are never followed.
- **A project secret instead (ADR-056):** a webhook may name one (`secret_ref`, a lower-case name) when the task is made
  by a project's app or agent token. The secret is looked up in the task's project and environment, and the project must
  have granted it to `actor` for `sign` (on openvibe.services, the project's Secrets page). OpenVibe.Network then signs
  each delivery over `"<t>.<raw body>"` in the same two headers, so the receiver's check is the same and Actor never
  holds the value. No `webhook_secret` is minted when every webhook names one. A secret Network refuses (missing, or not
  granted) fails that delivery at once; Network unreachable is retried on the usual backoff. A person's own task cannot
  name one (422 `actor.webhook.secret_unavailable`).

**Errors:** RFC 9457 problems. The codes are on [openvibe.actor/docs](https://openvibe.actor/docs#errors).

## Money

- **Free tier, per person:** `ACTOR_FREE_TASKS_PER_DAY` (20) tasks a day, up to `ACTOR_FREE_PER_TASK_USD` ($0.05) a task and `ACTOR_FREE_PER_DAY_USD` ($0.25) a day.
- **Operator ceiling:** `ACTOR_MAX_COST_USD_PER_DAY` ($2) over everyone; past it, new tasks answer 503 `actor.capacity.spent` until midnight UTC.
- **Budgets are hard:**
  - a budget above the tier is refused, never lowered;
  - a task whose cheapest capable agent would cost more than its budget fails before running;
  - an adapter stops before a call when nothing is left.
- **Billing:** OpenVibe.Billing (T5) is not in the loop yet. Every cent is the free allowance's, the operator pays the providers with keys in `/etc/openvibe/actor.env`, and `cost.free_allowance_used` says so.

## Owns

- Tasks, their event logs and daily spend (`migrations/0001_tasks.sql`). Tasks are kept 30 days, then pruned with their events. Nothing stored is a credential, a key or a token.
- Request telemetry (`migrations/0010_telemetry.sql`): each HTTP request is aggregated by route template, method and status class, never by raw URL. Once a minute one `http.request` sample per key, plus the active-requests, p95 latency and event-loop-lag gauges, is written to this service's own `telemetry_samples` table (openvibe-sdk 0.46 telemetry, the `platform.telemetry-sample@1` shape); rows older than 14 days are deleted daily. `/shared` files, static assets, health, readiness and `/metrics` are not counted. `server/app.js` builds the collector (`createHttpTelemetry`) and mounts its middleware; `server/index.js` flushes it every minute and on stop, and runs the 14-day retention.
- The agent catalog and its rate cards; the routing policy over them (placement itself is `openvibe-sdk/placement`).
- The home page (`server/http/pages.js`, `public/css/home.css`, `test/home.test.js`): the task box, numbers read from the catalog, the running config and OpenVibe.Tools' catalog (the runtime's own cached copy, waited for at most a second), task templates that fill the task box (`/?task=…&mode=…`, kept by no shared cache; signed out, the task waits for sign-in), the Tools tools the runtime can run, the agents, the API samples and the questions people ask first, with JSON-LD WebSite, WebApplication, WebPage, ItemList (the agents) and FAQPage (exactly the questions shown).

## Does not own

- Coding: **OpenVibe.Codes** (the coding-agent harness).
- Execution sandboxes, browsers and desktops: **OpenVibe.Run** / **OpenVibe.Node** (next).
- Accounts, apps and grants: **OpenVibe.Network** and **OpenVibe.Services**.
- The tools the runtime uses: **OpenVibe.Tools**. Search: **OpenVibe.Search**.

## Depends on

**Services it calls at runtime** (base URLs in [server/config.js](server/config.js)):

- **OpenVibe.Network** (`OV_NETWORK_URL`, `OV_NETWORK_INTERNAL_URL`): sign-in (OAuth2 + PKCE, client `actor`), the JWKS that verifies session and app tokens, and the internal routes (with this service's own client-credentials token) where account export parts and deletion confirmations are pushed.
- **OpenVibe.Search** (`ACTOR_SEARCH_URL`): content across the network, for the runtime's `search_openvibe` tool.
- **OpenVibe.Tools** (`ACTOR_TOOLS_URL`): the catalog, the run API and the page reader, for `find_tools`, `run_tool` and `read_page`. Called as any anonymous caller would.
- **OpenVibe.Bot** (`ACTOR_BOT_URL`, default `http://127.0.0.1:4630`; empty turns it off): a signed-in person's own robots, for `list_my_robots` and `robot_steps`. Actor calls Bot with its own client-credentials token (audience `openvibe.bot`, `bot.robot.read` + `bot.robot.control`) and `X-OV-Subject` naming the person. Bot answers only for the robot's owner, and only on robots where that owner turned on "Let my OpenVibe.Actor agent drive this robot". Bot's gate, limits and e-stop judge every step. App, agent and service tasks never see these tools.
- **The Console** (`/console`, plan T17 layer 3): one page for a signed-in person. It has a command box (the ordinary task form) and their running and recent tasks; it refreshes itself while something runs, never while they type. It shows what waits for them: their approvals, and approvals waiting on their own computers. It also shows today's spend against the free tier, their agents, and their computers and robots, read from OpenVibe.Bot as them with a 4 s bound, so a slow Bot never holds the page. Links go to Services, Watch and Codes for the rest. It works without JavaScript (`server/http/console-pages.js`, `test/console.test.js`).
- **A person's own computers, also through OpenVibe.Bot** (plan T14/T17, contracts 0.166.0): `list_my_computers`, `computer_list`, `computer_read`, `computer_run` (argv, never a shell line) and `computer_write`, on machines installed with OpenVibe Node's `--computer` plugin. Actor calls Bot's machine API with its own token (`bot.computer.control`) and `X-OV-Subject` naming the person. Bot answers only for the machine's owner, and only where that owner turned on "Let my agent use this computer". The level the owner set on the machine decides what may happen there; at `ask`, each run or write waits up to two minutes for the owner's approval on the machine. Only a signed-in person's task sees these tools (`server/agents/computers.js`, `test/computers.test.js`). `computer_screen` (when an OpenAI key is set) takes a picture of the machine's screen through Bot (1280 px wide) and has OpenAI's vision model answer the agent's question about it. The runtime model gets that answer, never the picture; the picture is not stored; secrets visible on screen are named, not repeated; and each look is metered on the task like any model call (refused once the task's budget is spent). `computer_input` (offered with `computer_screen`; contracts 0.171.0) uses the mouse and keyboard: a click, double or right click or move at a position in the last screen picture (its width and height are passed, and the Node scales them to the real screen), a scroll, typed text, or one key or chord. It is an acting command, so at level `ask` each one waits for the person's approval on the machine; the runtime is told to look first, act in small steps, look again, and never type a secret the task did not give it.
  - `computer_browser` (contracts 0.174.0, Node v0.10.0) drives a browser of the agent's own on the machine. It is a
    profile of its own, so it never sees the person's sessions.
  - It can open a URL, click a selector or a visible link or button, fill a field, press a key, go back, read the
    page, take a screenshot and close. The page comes back as its text (up to 3,500 characters) and links (up to 25),
    which fits the result clip, so the tool is offered without a vision key.
  - Reading, screenshots and closing run at every level; the rest wait for approval at `ask`. Below `full` the machine
    refuses addresses on its own network.
  - Approvals can come from the Node's tray or notification buttons, as well as `openvibe-node approve` (Node v0.11.0).
- **OpenVibe.Events** (`ACTOR_EVENTS_URL`): the two ADR-033 subscriptions created at boot, plus `chat.message.created` while asking from chat is on, and delivery to the loopback `/internal/events`.
- **OpenVibe.Chat** (`ACTOR_CHAT_URL`, default `http://127.0.0.1:4400`): **ask Actor from chat** ([server/chat/asks.js](server/chat/asks.js)).
  - **Who and where:** a signed-in person writes `@actor <task>` in the global chat or their own channel's chat. Guests, relayed external chatters (`source_platform`) and other people's channels are ignored.
  - **How it runs:** the message becomes their task, on their free tier, with `via: chat`. The answer is posted where everyone reads it, so the task uses public tools only. The engine refuses a robot, computer or coding task (`actor.task.not_public`), and the runtime is never given the person's robots or computers.
  - **The reply:** the first lines of the answer and the task's page, posted in the same room as "OpenVibe Actor", answering the message. It goes through Chat's service API (`chat.message.send`, audience `openvibe.chat`) and is retried with backoff for up to an hour.
  - **Limits:** 5 asks an hour per person and 60 across everyone (`ACTOR_CHAT_ASKS_PER_HOUR`, `ACTOR_CHAT_ASKS_ALL_PER_HOUR`). Past a limit, one reply says so and further asks are dropped quietly.
  - **Data:** `actor_chat_asks` (migration 0009) is part of the person's export and erasure.
  - `ACTOR_CHAT_ASKS=0` turns it off.
- **The model providers**: DeepSeek (`ACTOR_DEEPSEEK_API_KEY`, `api.deepseek.com`), OpenAI (`ACTOR_OPENAI_API_KEY`, `api.openai.com/v1`) for the web-search agent and the cross-family check, and an OpenAI-compatible local server (`ACTOR_LOCAL_LLM_URL`) for private mode.

**Data:** PostgreSQL (openvibe-sdk/db, `DATABASE_URL` / `DATABASE_DIRECT_URL`) holds tasks, their events and daily spend; Valkey (`VALKEY_URL`) holds the shared per-caller limit counters. A provider or service without its key or URL is listed unavailable, never invented.

**Libraries:** openvibe-contracts (contract validation, problem responses, service-token verification, capability checks); openvibe-sdk (`placement` for routing, `auth`, `db`, `limits`, `account-data`, `valkey`, `service`); openvibe-shared (`serve`, `cache-policy`, `frame`, `shell`, `showcase`, `seo`, `legal`, `release`, `metrics`, `ready`); express, helmet, express-rate-limit, cookie-parser, pg, iovalkey.

## Capabilities

- **Required on this API:** `actor.task.create` (create a task, cancel one), `actor.task.read` (one task, its live stream), `actor.task.list` (list your tasks). A person acting for themself needs no capability; an app, agent or service token for audience `openvibe.actor` needs the one the route names, granted on OpenVibe.Services. A **first-party service** (`svc:`) may act for a person who asked it to by naming them in `X-OV-Subject` (OpenVibe.Watch's actor-task action): the task is the person's (their allowance, their list, their export and deletion) and records the service as `via`; the service still needs the route's capability, and it reads, lists and cancels only the tasks it started. A developer app or an agent never names a person this way (`403 subject.not_delegated`). `actor.agent.read` is the code's name for the catalog and the dry run, which are public.
- **Personal agents:** `actor.agent.manage` guards management and memory, and `actor.agent.run` guards runs and their list for a token. Browser sessions and a person's own token work as task calls do. The new capability manifests are pending in OpenVibe.Contracts.
- **Held on other services:** a client-credentials token for audience `openvibe.events`, scope `events.subscription.manage`, creates the two ADR-033 subscriptions at OpenVibe.Events; the same `actor` principal's token pushes account export parts and deletion confirmations to OpenVibe.Network's internal routes.
- **Not held:** the runtime presents no grant to OpenVibe.Search or OpenVibe.Tools — it uses only what any anonymous caller may call.

## What comes next

1. Browser and desktop agents on OpenVibe's own cheap servers (Run workers with a headless browser and a virtual desktop), watchable live and taken over by the owner.
2. Coding through OpenVibe.Codes on hosted Run sandboxes.
3. More agent platforms behind the same router, bring-your-own keys through OpenVibe.AI, and paid tiers through Billing.
4. Personal agents v1 are in this worktree: named instructions, memory people control, hourly/daily/weekly schedules and ordinary task runs. An approval inbox (a coding task an agent wants to start waits for its owner) and Watch triggers (a watch hands its
task to an agent when its condition fires) are built, and so is asking Actor from chat (`@actor …`). Frame access comes later.

## Run your own

A self-hosted Actor ([docs/self-host.md](docs/self-host.md)): `npm run selfhost:init`, then
`docker compose -f docker-compose.selfhost.yml --profile ollama up -d`.
- One owner signs in with a password, and the API takes their own token.
- One process, with its database on disk (PGlite) unless `DATABASE_URL` is set.
- The OpenVibe runtime runs on any OpenAI-compatible model (`ACTOR_RUNTIME_URL`), at the operator's price, listed as
  user-owned. With no other model family, it checks its own answers and says so.
- OpenVibe's public Search and Tools are used anonymously, or not at all.
- The parts that need an OpenVibe service identity are off: Bot, Codes, chat asks and Network-signed webhooks.

## Configuration

See [.env.example](.env.example). Required in production:
- `OV_OAUTH_CLIENT_SECRET` (the `actor` principal; `server/setup/service-principal.js create actor` on the Network writes it);
- `BASE_URL`, `DATABASE_URL` and `DATABASE_DIRECT_URL`;
- at least one agent: `ACTOR_DEEPSEEK_API_KEY`, `ACTOR_OPENAI_API_KEY`, or `ACTOR_LOCAL_LLM_URL` + `ACTOR_LOCAL_LLM_MODEL`.

Readiness requires the database and at least one available agent.

## Deploy (for the lead)

- **Deploy:** `sudo ovhost deploy actor` on the host (git checkout at `/opt/openvibe.actor`, unit `openvibe-actor.service` on 127.0.0.1:4950, env `/etc/openvibe/actor.env`, database `ov_actor` on the data role).
- **nginx:** [deploy/nginx/openvibe.actor.conf](deploy/nginx/openvibe.actor.conf), installed with `ov-vhost-install`. A task's event stream is unbuffered.
- **Rollback:** ovhost puts the previous sha back by itself when `/api/ready` does not answer after the restart.
- **A stop:** running tasks are stopped and recorded as `actor.task.interrupted`. They are never re-run behind the person's back.

## Acceptance

Run the suite with Node 22 (the Development block below):

- `npm test` — every [test/*.test.js](test/) in its own process on temp PGlite databases, with in-process mocks of OpenVibe.Network, OpenVibe.Events and OpenVibe.Media and stand-in model providers; nothing needs the network or a running site.
- `npm run test:pg` — the same suite against PostgreSQL instead of PGlite.
- `npm test -- <word>` runs only files whose name contains a word; `npm test -- --strict` makes a skipped test fail the run.

What the main tests prove:

- [test/tasks.test.js](test/tasks.test.js): a task end to end through the API and the real adapters — classified, routed, run, checked, delivered as `platform.task@1` with its cost and explanation; hand-off to the next agent on an error or a failed check; private mode never sending the text outside OpenVibe; hard budgets and the free tier; idempotency; cancel; the live stream replaying and ending; nobody seeing another person's task.
- [test/contracts.test.js](test/contracts.test.js): the released `actor` service manifest and its four capability manifests match the routes, guards and response shapes in the code.
- [test/account-data.test.js](test/account-data.test.js): the ADR-033 export and deletion through the signed `/internal/events` route carry only the person's rows; a redelivery erases nothing twice, and a bad signature or a forwarded request is refused.
- [test/caller-limits.test.js](test/caller-limits.test.js): one caller past its limit gets 429 before any work while another passes; the budgets and the `actor_rate_limited_total` metric are pinned.
- [test/security-ssrf.test.js](test/security-ssrf.test.js), [test/security-secrets.test.js](test/security-secrets.test.js) and [test/security-session.test.js](test/security-session.test.js): Actor never fetches a URL from a request or a task, outbound requests reach only configured bases, no secret leaves in a body or a log, and a FedCM assertion is not a session.

The remaining files cover sign-in (PKCE, state, redirect safety), the Network JWKS, the pages and layout, crawl artifacts, asset caching, per-file size budgets, graceful stop and the nginx sign-in limits.

## Development

```bash
npm install
fnm exec --using=22 npm test        # every test/*.test.js on temp PGlite databases, a mock Network and stand-in providers
fnm exec --using=22 npm run dev     # http://localhost:4950 (agents without keys are listed as unavailable)
```

Tests:
- [test/tasks.test.js](test/tasks.test.js) runs a task end to end through the real adapters against stand-in providers, Tools and Search. It covers routing per class and mode, the cross-family check, hand-off on an error or a failed check, private mode never sending the text outside, hard budgets and the free tier, idempotency, cancel, the live stream, visibility, cross-site writes, and app tokens with capabilities.
- The other files cover sign-in (PKCE, state, next=), discovery, the released contracts manifest matching the routes, per-caller limits, readiness, secrets never stored or logged, Actor never fetching a URL from a task, and the home page's size budgets.

## Account export and deletion

A person's account at OpenVibe.Network can be exported and deleted, and every service holding their rows answers its
part (ADR-033). Actor receives `network.account.export_requested` and `network.account.deleted` at `POST /internal/events`
(loopback only) — the two tables are mapped in [server/identity/account-data.js](server/identity/account-data.js), and
the boot-time subscriptions are created by [server/events-consumer.js](server/events-consumer.js):

- **Exported:** the tasks a person asked for (`tasks.json`), what they spent per UTC day (`spend.json`), their agents (`agents.json`) and every memory note (`agent-memory.json`), pushed to
  `POST /internal/account-exports/:id/parts` with this service's own token. Nothing here is a secret — Actor stores no
  token, key or credential.
- **Erased:** all four tables hold the person's own rows, so they are deleted whole and nothing is kept; a task's event log
  (`task_events`) goes with the task by cascade. Actor then confirms with `POST /internal/account-deletions/:id/confirmations`
  and the counts.
- **Anonymized:** nothing. There is no row Actor keeps that was written by this person for another person to read.

A task an app, agent or service ran for this person is not matched: its requester is `app:…`/`agent:…`/`service:…`, and
Network's deletion event carries only the person's `usr_…`, so only rows requested as `user:usr_…` are erased. The spend
row that does not name the person (`*`, the operator's daily ceiling) is a separate row and is kept.

Environment: `ACTOR_EVENTS_SECRET` (comma-separated for rotation, 32+ characters each; unset makes the route answer
503), `ACTOR_EVENTS_URL` (or `EVENTS_URL`) is where the two subscriptions are created at boot (off when unset), and
`ACTOR_EVENTS_ENDPOINT` overrides the loopback endpoint; `ACTOR_EVENTS_SUBSCRIBE=0` turns the boot-time subscription off.

## Security (threat notes)

Reporting a vulnerability: [SECURITY.md](SECURITY.md).

- Session tokens are httpOnly cookies; a FedCM assertion or an app or service token is never a session.
- Provider keys live only in the env file and in outbound `Authorization` headers to the providers; OpenVibe services get no provider key.
- A model's links in an answer are rendered `rel="nofollow ugc noopener"`; all answer text is escaped first (a small Markdown subset).
- Tasks are people's words: request bodies are never logged.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).

<!-- versions:start -->
- openvibe-contracts: v0.214.0
- openvibe-sdk: v0.64.0
- openvibe-shared: v4.12.0
<!-- versions:end -->
