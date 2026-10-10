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
| OpenVibe runtime | openvibe-runtime | answer, lookup, research | external (the model runs at DeepSeek) | DeepSeek Flash, $0.30 in / $1.20 out per 1M tokens (peak; off-peak is half, Actor charges peak) |
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
| `POST /api/v1/tasks` | `actor.task.create` | `actor.task-create-request@1` → `platform.task@1` (201, queued) |
| `GET /api/v1/tasks/:id` | `actor.task.read` | the task |
| `GET /api/v1/tasks/:id/events` | `actor.task.read` | server-sent events, `actor.task-event@1`, resumable with `Last-Event-ID` |
| `POST /api/v1/tasks/:id/cancel` | `actor.task.create` | stop it |
| `GET /api/v1/tasks` | `actor.task.list` | `actor.task-list-result@1` |
| `GET /api/v1/agents` | public | `actor.agent-list-result@1` |
| `POST /api/v1/route` | public | dry run: which agent and why (heuristic class; nothing runs or is charged) |
| `GET /api/v1/resources` | `actor.resource.read` (service token) | `common.resource-list-result@1` for `actor.task`; filters: `project`, `kind`, `cursor`, `limit` |
| `GET /api/v1/resources/:ovrn` | `actor.resource.read` (service token) | one `common.resource-summary@1` for a project-owned task |

The resource index is for OpenVibe.Services on loopback and is blocked at the public nginx vhost. It lists task summaries under the `actor.task` kind; only a service token with `actor.resource.read` can read it. A task without a project has no OVRN and cannot be fetched by name.

**Who can call it:**
- **A person:** their Network token as a Bearer, or this site's session. A write made with the session must come from openvibe.actor itself (fetch metadata or Origin).
- **An app, agent or service:** a token for audience `openvibe.actor` that holds the route's capability, granted on OpenVibe.Services. Its tasks belong to the token's project.

**What a caller can see:** a task is visible only to its requester, or to tokens of its project. Anyone else gets 404, the same answer as a task that doesn't exist.

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
- The agent catalog and its rate cards; the routing policy over them (placement itself is `openvibe-sdk/placement`).

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
- **OpenVibe.Events** (`ACTOR_EVENTS_URL`): the two ADR-033 subscriptions created at boot, and delivery to the loopback `/internal/events`.
- **The model providers**: DeepSeek (`ACTOR_DEEPSEEK_API_KEY`, `api.deepseek.com`), OpenAI (`ACTOR_OPENAI_API_KEY`, `api.openai.com/v1`) for the web-search agent and the cross-family check, and an OpenAI-compatible local server (`ACTOR_LOCAL_LLM_URL`) for private mode.

**Data:** PostgreSQL (openvibe-sdk/db, `DATABASE_URL` / `DATABASE_DIRECT_URL`) holds tasks, their events and daily spend; Valkey (`VALKEY_URL`) holds the shared per-caller limit counters. A provider or service without its key or URL is listed unavailable, never invented.

**Libraries:** openvibe-contracts (contract validation, problem responses, service-token verification, capability checks); openvibe-sdk (`placement` for routing, `auth`, `db`, `limits`, `account-data`, `valkey`, `service`); openvibe-shared (`serve`, `cache-policy`, `frame`, `shell`, `showcase`, `seo`, `legal`, `release`, `metrics`, `ready`); express, helmet, express-rate-limit, cookie-parser, pg, iovalkey.

## Capabilities

- **Required on this API:** `actor.task.create` (create a task, cancel one), `actor.task.read` (one task, its live stream), `actor.task.list` (list your tasks). A person acting for themself needs no capability; an app, agent or service token for audience `openvibe.actor` needs the one the route names, granted on OpenVibe.Services. A **first-party service** (`svc:`) may act for a person who asked it to by naming them in `X-OV-Subject` (OpenVibe.Watch's actor-task action): the task is the person's (their allowance, their list, their export and deletion) and records the service as `via`; the service still needs the route's capability, and it reads, lists and cancels only the tasks it started. A developer app or an agent never names a person this way (`403 subject.not_delegated`). `actor.agent.read` is the code's name for the catalog and the dry run, which are public.
- **Held on other services:** a client-credentials token for audience `openvibe.events`, scope `events.subscription.manage`, creates the two ADR-033 subscriptions at OpenVibe.Events; the same `actor` principal's token pushes account export parts and deletion confirmations to OpenVibe.Network's internal routes.
- **Not held:** the runtime presents no grant to OpenVibe.Search or OpenVibe.Tools — it uses only what any anonymous caller may call.

## What comes next

1. Browser and desktop agents on OpenVibe's own cheap servers (Run workers with a headless browser and a virtual desktop), watchable live and taken over by the owner.
2. Coding through OpenVibe.Codes on hosted Run sandboxes.
3. More agent platforms behind the same router, bring-your-own keys through OpenVibe.AI, and paid tiers through Billing.
4. Personal agents (`agt_` principals on the Network): memory people control, schedules and Events triggers, an approval inbox, reachable from Chat and the Frame.

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

- **Exported:** the tasks a person asked for (`tasks.json`) and what they spent per UTC day (`spend.json`), pushed to
  `POST /internal/account-exports/:id/parts` with this service's own token. Nothing here is a secret — Actor stores no
  token, key or credential.
- **Erased:** both tables hold the person's own rows, so they are deleted whole and nothing is kept; a task's event log
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
- openvibe-contracts: v0.129.0
- openvibe-sdk: v0.38.0
- openvibe-shared: v3.0.0
<!-- versions:end -->
