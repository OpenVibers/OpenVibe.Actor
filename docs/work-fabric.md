# Actor work fabric (S4)

`ACTOR_WORK_FABRIC=1` enables the backend and its executor/model adapters. It is off by default. Each agent starts with `observe` policy, empty allowed lists and zero budget. There are no UI changes. Configured Sources take over matching events from the legacy Chat/Mail intake, so an event cannot launch through both paths. Unconfigured events retain the existing path.

## Transaction and integration boundary

`server/fabric/engine.js` has synchronous commands. `service.js` locks one agent's database aggregate, runs one command, then commits its state, source cursors and stored work together. A thrown validation error rolls everything back. Model and network calls run outside the transaction. Commands for different agents use different row locks. This initial implementation stores an agent's history as one JSONB aggregate: it favors atomicity and auditability over high-volume throughput; archival/partitioning is future work before high-volume rollout.

`agent.trigger@1`, `agent.ticket@1` and `agent.decision@1` validate the durable domain records. Internal delivery leases, subscriptions and disposition metadata are separate from those wire records. The existing `server/task-view/tickets.js` is a different read model and is not replaced.

An owner uses their `actor.agent.manage` credential:

- `GET /api/v1/fabric/:agent` reads state and revision.
- `POST /api/v1/fabric/:agent/commands/configure` stores `{sources, policy}`.
- Commands `start`, `decide`, `attach`, `stop`, `end`, `subscribe`, `unsubscribe`, `handBack`, `read`, `reply`, `schedule`, `cancelSchedule`, `tick`, `claim`, `settle`, `delivered`, `bind`, `report`, `promote`, `demote` expose the engine ports. Unknown commands and foreign agents are refused. Source intake is not a public command.

Source configuration maps instance ids to `{kind, enabled, self, scopes, receive_all}`. Chat additionally takes `mentions` (names without @); Mail takes `mail_agent`. The service stamps `owner_subject` from the authenticated owner, ignoring caller-supplied identities. Scope names are `global`, `channel:<id>`, `dm:<id>`, `inbox:<id>`, or configured time scope names. DMs must include both the bound agent identity and the owner. Mail events must name the owner's configured inbox and agent. Mail reads the original through the existing authorized Mail read client before entering the transaction, checks the server-stamped owner, inbox and sender, and groups replies by the References root. Chat room reply chains form Threads; separate top-level mentions do not share ownership. Own messages and events outside scope are dropped before domain intake. DM Events contain identifiers rather than text: the Trigger preserves these facts with a read pointer; workers must read the original through their authorized Chat connection.

Policies contain `mode` (`off|observe|auto`), `rules` (`id`, `enabled`, `instruction`, optional `mode` `observe|auto`), `budget` (`usd`, `tokens`, `wall_minutes`) and `sources`. A rule without a mode is in observe: a lane never inherits autonomy from a global switch by accident. Each Source policy has `allowed`, `bots` and an `admission` table keyed by scope, with `listed_unaddressed`, `unlisted_addressed` and `unlisted_unaddressed` cells. The first and last allow `inferred|ignore`; unlisted addressed also allows `explicit`. No identities are mapped between Sources.

## Routing and workers

A `start` command batches pending Triggers on one Thread. While that evaluation runs, new events form its next batch. Explicit candidates produce `route` work; inferred candidates produce `assess` work. The router only routes; it cannot replace a worker-owned follow-up with new work. It may stop a Ticket on an explicitly authorized person's message.

The assessor returns `decision`, `scope`, `direction` and `rule_assessments`. Direction contains `implementation_requested`, `target_basis` (`specified|existing-standard|undetermined`), `requires_design_decision` and `evidence` entries `{trigger_id, quote}`. Every quote must occur in the original Trigger and every enabled rule must be assessed exactly once. Inferred acceptance needs settled direction and a matched rule, and every matched lane in `auto`. Observe records `ignore` with `would_accept`, with no launch or reply. The `ignored_from_card` shortcut can only ignore, with a reason. A missing/failed assessment should return `unavailable`; delivery starts the timeout, and three delivered expiries end unavailable after two retries.

Acceptance creates an immutable Mandate and `launch` work. Subscriptions deliver later events directly through `input` work without changing authority. Human own-thread messages stay with their workers until all owners hand them back, once each with a reason. `context` subscriptions neither own messages nor resume ended Tickets. `attach` requires the message to explicitly name the Ticket. A worker cannot unsubscribe from origin or Source-bound Threads. `read` is called only after a step consumed the input and a report/turn end followed; ending releases unread messages. Full session-level read accounting and report/stage integration are S6.

`end` ends a worker round; it does not withdraw authority. A person's follow-up can resume it after current-policy revalidation, while bots cannot. `end` with `person:true` is the owner's manual stop. `stop` checks the originating human Trigger's explicit gate strength. Stopped Tickets never resume. Policy changes discard pending evaluations and notify affected live workers without cancelling their mandates.

## Stored work

Adapters claim `route`, `assess`, `launch`, `input`, `end` or `reply` work, perform it after the claim commits, then settle using the claim token. `createFabric().drain(owner, agent, handlers)` provides this boundary for in-process adapters. Handlers receive a Ticket-bound worker port: it cannot change policy, accept work, claim a human stop, or create an authoritative subscription.

`server/fabric/adapters.js` is the adapter set the feature flag enables. It performs no work while the switch is off:

- `route` is deterministic: an explicit human ask becomes a Ticket, with no model call.
- `assess` makes one cheap model call on Actor's model layer (`models.chat({tier:'check', json:true})`), shapes the answer as `agent.decision@1`, and records `unavailable` with a plain reason when the model cannot answer. It never invents evidence; the engine still checks every quote and every enabled rule.
- `launch` assigns the mandate to the owner's agent through `personal.run` — the same path as a personal agent's scheduled run — which creates a task and an assignment root. A follow-up `input` is one more run of the same agent, as a child of the Ticket's current task.
- `reply` posts the worker's answer back to the Chat room named by the Source scope (or replies to the Mail letter named by the Trigger's read pointer).

The task-to-Ticket binding is written in the task's own insert transaction (`actor_fabric_tasks`, migration 0060), so a run can never end without a report target. When an Actor task ends, the task engine calls the adapter's `onTaskState`; it records one `agent.report@1` on the Ticket (`ready`, `failed` or `dropped`), ends the Ticket, and queues one reply. Tasks started by anything else have no binding and are ignored. `server/index.js` drains all fabrics every two seconds while the switch is on; the drain claims one item at a time and settles it before the next.

Each adapter must honor the stable idempotency key. Transport is at-least-once; a crash after sending and before settlement retries the same key. Expiring leases recover interrupted sends; stale lease tokens cannot settle newer claims. Retries start at 2 seconds and double to 60 seconds (replies: 5 to 300 seconds). Earlier work blocks later work in the same conversation. Other conversations proceed independently. Replies wait while their Source is off and drop only when its destination is no longer listened to or cannot receive. Drops retain their reason and time and cannot be requeued with the same key. Resume launches include a recovery instruction to inspect existing work before repeating outside actions.

## Observe then auto (S5)

A lane is one entry in `policy.rules`. Its mode is `observe` or `auto`; a rule with no mode is in observe. The top-level
`mode` is the master switch: `off` admits no inferred work, `observe` holds every lane in observe, and `auto` lets each
lane follow its own mode. Explicit human asks are unaffected by lane modes. `promote` also sets the master to `auto`.

In observe, an inferred evaluation is recorded in the aggregate (`state.observe`) and in `actor_fabric_observe` with the
gate's verdict and basis, the assessment direction and per-rule reasons, what the lane would have done, and the
estimated cost. Nothing is launched. The estimate is Actor's own data: the low and high USD cost of the agent's last
finished runs (at least three), with basis `the last N finished runs of this agent`. Fewer than three is `null` with
basis `no data yet`; a gate that admits nothing is 0 with `nothing would run`. The aggregate keeps the newest 500
records; every row is mirrored to SQL in the same transaction that commits the aggregate.

Every promotion and demotion is written to `actor_fabric_lane_changes` with the actor (`owner` or `system`) and the reason
in words. Two things demote without the owner: a gate that cannot decide (`unavailable`) puts every auto lane back in
observe with `The gate could not decide: <reason>.`; a task report that reaches the mandate's USD budget puts the
Ticket's matched lanes back with `The job used its whole budget of $X.` Neither cancels work already running; the owner
re-promotes after reading the records.

### Endpoints for the panel

All are owner-only (`actor.agent.manage`); a foreign agent is 404. `GET /api/v1/fabric/:agent/lanes`:

```json
{
  "agent": "agt_01JZ0000000000000000000AAA",
  "mode": "auto",
  "policy_version": "8f1c…",
  "budget": { "usd": 1, "tokens": 1000, "wall_minutes": 10 },
  "lanes": [{
    "rule_id": "fix",
    "instruction": "Fix requested defects",
    "enabled": true,
    "mode": "observe",
    "promoted_at": null,
    "demoted_at": "2026-11-09T17:02:11.000Z",
    "demote_reason": "The job used its whole budget of $1.00. This lane is in observe until you promote it again.",
    "observe": { "count": 12, "last_at": "2026-11-09T17:01:58.000Z" },
    "last_change": { "from_mode": "auto", "to_mode": "observe", "reason": "The job used its whole budget of $1.00. This lane is in observe until you promote it again.", "actor": "system", "at": "2026-11-09T17:02:11.000Z" },
    "report_counts": { "progress": 3, "waiting": 0, "ready": 8, "blocked": 1, "failed": 1, "dropped": 0 }
  }],
  "report_states": [
    { "state": "progress", "label": "Working", "meaning": "The executor is working on the Ticket." },
    { "state": "waiting", "label": "Waiting", "meaning": "The executor is waiting for a trigger or an event." },
    { "state": "ready", "label": "Ready for review", "meaning": "The work is done and ready for the owner to review." },
    { "state": "blocked", "label": "Blocked", "meaning": "The executor cannot continue without a person." },
    { "state": "failed", "label": "Failed", "meaning": "The last run failed." },
    { "state": "dropped", "label": "Dropped", "meaning": "The work was stopped or dropped and will not continue." }
  ]
}
```

`GET /api/v1/fabric/:agent/observe?lane=fix&limit=20` (`lane` optional, `limit` 1–200, newest first):

```json
{
  "agent": "agt_01JZ0000000000000000000AAA",
  "lane": "fix",
  "records": [{
    "id": "observe_184", "seq": 184, "at": "2026-11-09T17:01:58.000Z", "thread": "thread_…",
    "mode": "observe", "trigger_ids": ["trigger_…"], "rule_ids": ["fix"],
    "gate": { "admitted": true, "strength": "inferred", "basis": "table", "decision": "accept" },
    "decision": "ignore", "would_accept": true,
    "scope": "Fix the broken test",
    "would_do": { "action": "launch", "summary": "Would have started work: Fix the broken test" },
    "estimate": { "low_usd": 0.02, "high_usd": 0.06, "basis": "the last 3 finished runs of this agent" },
    "demoted_rules": [], "reason": "Observe: nothing was launched. Promote this lane to auto to let it act.",
    "direction": { "implementation_requested": true, "target_basis": "specified", "requires_design_decision": false, "evidence": [{ "trigger_id": "trigger_…", "quote": "broken test" }] },
    "rule_assessments": [{ "rule_id": "fix", "matched": true, "reason": "The message names a broken test" }]
  }],
  "report_states": ["the same six objects as above"]
}
```

`GET /api/v1/fabric/:agent/reports` returns `{agent, tickets: [{ticket_id, state, stage, lanes, threads, reports}], report_states}`; each report is the stored `agent.report@1` (`progress|waiting|ready|blocked|failed|dropped`). The first row of `agent.stage@1` that matches the latest report is the ticket's `stage`.

`POST /api/v1/fabric/:agent/commands/promote` with `{"lane":"fix"}` → `{"lane":"fix","mode":"auto","policy_version":"…","changed":true}`. The panel re-reads `/lanes` for the new `last_change`.

`POST /api/v1/fabric/:agent/commands/demote` with `{"lane":"fix","reason":"Reading a few more runs first."}`, or `{"reason":"…"}` to demote every lane and the master switch → `{"lane":"fix","mode":"observe","policy_version":"…","changes":[{"rule_id":"fix","from_mode":"auto","to_mode":"observe","reason":"…","actor":"owner"}]}`.

Time belongs to `sources.js`, not assessment. A schedule is `{id, source, scope, due, text, interval_ms?}`; timestamps are epoch milliseconds. A quiet condition adds `{quiet_thread, since_trigger}`. The Source cancels it if that Thread changes before its due time. Time produces immutable system Triggers; admission requires `clock` in the Source's bot list and the scope in `receive_all`. Time never grants explicit authority. `tick` checks due conditions, expires evaluations and starts pending batches; it never sleeps or calls a model.

Account export/deletion includes the fabric aggregate and the task-to-Ticket binding. The expand-only migrations add no production writes during development. Tests name the corresponding rules from reference docs 001–003; `ov test test/fabric.test.js test/fabric-store.test.js test/fabric-adapters.test.js test/fabric-executors.test.js test/fabric-observe.test.js test/fabric-observe-store.test.js` exercises policy, intake, persistence, ownership, routing, delivery, adapters, observe records, promotion/demotion, the six report states and one real run on the stand-in providers without external services.
