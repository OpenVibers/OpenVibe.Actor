# OpenVibe.Actor

> Your agent for everything: give a task in plain words, and Actor sends it to the best agent for it — OpenVibe's own, acting through every OpenVibe service, or another platform's — has a second model check the answer, and shows you what it cost and why. Like OpenRouter, for agents.

**Status:** alpha. Public at `https://openvibe.actor` (openvibe-ovh, unit `openvibe-actor` on 127.0.0.1:4950 behind nginx). See [STATUS.json](STATUS.json) for exactly what works and what does not.
**Domain:** `openvibe.actor` · **Port:** 4950 · **Service id:** `actor`
**Plan:** T17 (owner direction 2026-10-08: OpenVibe's own general agent, competing with the big labs' agents while able to use theirs; an OpenRouter for agents; cheap self-hosted browser and desktop agents). Decisions: [ADR-044](https://github.com/OpenVibers/OpenVibe.Contracts/blob/main/docs/adr/ADR-044-actor-runtime.md) (proposed).
**License:** AGPL-3.0 (same as every OpenVibe service).

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

## What comes next

1. Browser and desktop agents on OpenVibe's own cheap servers (Run workers with a headless browser and a virtual desktop), watchable live and taken over by the owner.
2. Coding through OpenVibe.Codes on hosted Run sandboxes.
3. More agent platforms behind the same router, bring-your-own keys through OpenVibe.AI, and paid tiers through Billing.
4. Personal agents (`agt_` principals on the Network): memory people control, schedules and Events triggers, an approval inbox, reachable from Chat and the Frame.
5. Account export and deletion (ADR-033). Until then, tasks expire after 30 days.

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

## Development

```bash
npm install
fnm exec --using=22 npm test        # every test/*.test.js on temp PGlite databases, a mock Network and stand-in providers
fnm exec --using=22 npm run dev     # http://localhost:4950 (agents without keys are listed as unavailable)
```

Tests:
- [test/tasks.test.js](test/tasks.test.js) runs a task end to end through the real adapters against stand-in providers, Tools and Search. It covers routing per class and mode, the cross-family check, hand-off on an error or a failed check, private mode never sending the text outside, hard budgets and the free tier, idempotency, cancel, the live stream, visibility, cross-site writes, and app tokens with capabilities.
- The other files cover sign-in (PKCE, state, next=), discovery, the released contracts manifest matching the routes, per-caller limits, readiness, secrets never stored or logged, Actor never fetching a URL from a task, and the home page's size budgets.

## Security (threat notes)

Reporting a vulnerability: [SECURITY.md](SECURITY.md).

- Session tokens are httpOnly cookies; a FedCM assertion or an app or service token is never a session.
- Provider keys live only in the env file and in outbound `Authorization` headers to the providers; OpenVibe services get no provider key.
- A model's links in an answer are rendered `rel="nofollow ugc noopener"`; all answer text is escaped first (a small Markdown subset).
- Tasks are people's words: request bodies are never logged.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).

<!-- versions:start -->
- openvibe-contracts: v0.115.0
- openvibe-sdk: v0.35.2
- openvibe-shared: v2.15.0
<!-- versions:end -->
