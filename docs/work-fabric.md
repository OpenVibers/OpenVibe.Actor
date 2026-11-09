# Actor work fabric (S4)

`ACTOR_WORK_FABRIC=1` enables the backend. It is off by default. Each agent starts with `observe` policy, empty allowed lists and zero budget. There are no UI changes. Configured Sources take over matching events from the legacy Chat/Mail intake, so an event cannot launch through both paths. Unconfigured events retain the existing path.

## Transaction and integration boundary

`server/fabric/engine.js` has synchronous commands. `service.js` locks one agent's database aggregate, runs one command, then commits its state, source cursors and stored work together. A thrown validation error rolls everything back. Model and network calls run outside the transaction. Commands for different agents use different row locks. This initial implementation stores an agent's history as one JSONB aggregate: it favors atomicity and auditability over high-volume throughput; archival/partitioning is future work before high-volume rollout.

`agent.trigger@1`, `agent.ticket@1` and `agent.decision@1` validate the durable domain records. Internal delivery leases, subscriptions and disposition metadata are separate from those wire records. The existing `server/task-view/tickets.js` is a different read model and is not replaced.

An owner uses their `actor.agent.manage` credential:

- `GET /api/v1/fabric/:agent` reads state and revision.
- `POST /api/v1/fabric/:agent/commands/configure` stores `{sources, policy}`.
- Commands `start`, `decide`, `attach`, `stop`, `end`, `subscribe`, `unsubscribe`, `handBack`, `read`, `reply`, `schedule`, `cancelSchedule`, `tick`, `claim`, `settle`, `delivered` expose the engine ports. Unknown commands and foreign agents are refused. Source intake is not a public command.

Source configuration maps instance ids to `{kind, enabled, self, scopes, receive_all}`. Chat additionally takes `mentions` (names without @); Mail takes `mail_agent`. The service stamps `owner_subject` from the authenticated owner, ignoring caller-supplied identities. Scope names are `global`, `channel:<id>`, `dm:<id>`, `inbox:<id>`, or configured time scope names. DMs must include both the bound agent identity and the owner. Mail events must name the owner's configured inbox and agent. Mail reads the original through the existing authorized Mail read client before entering the transaction, checks the server-stamped owner, inbox and sender, and groups replies by the References root. Chat room reply chains form Threads; separate top-level mentions do not share ownership. Own messages and events outside scope are dropped before domain intake. DM Events contain identifiers rather than text: the Trigger preserves these facts with a read pointer; workers must read the original through their authorized Chat connection.

Policies contain `mode` (`off|observe|auto`), `rules` (`id`, `enabled`, `instruction`), `budget` (`usd`, `tokens`, `wall_minutes`) and `sources`. Each Source policy has `allowed`, `bots` and an `admission` table keyed by scope, with `listed_unaddressed`, `unlisted_addressed` and `unlisted_unaddressed` cells. The first and last allow `inferred|ignore`; unlisted addressed also allows `explicit`. No identities are mapped between Sources.

## Routing and workers

A `start` command batches pending Triggers on one Thread. While that evaluation runs, new events form its next batch. Explicit candidates produce `route` work; inferred candidates produce `assess` work. The router only routes; it cannot replace a worker-owned follow-up with new work. It may stop a Ticket on an explicitly authorized person's message.

The assessor returns `decision`, `scope`, `direction` and `rule_assessments`. Direction contains `implementation_requested`, `target_basis` (`specified|existing-standard|undetermined`), `requires_design_decision` and `evidence` entries `{trigger_id, quote}`. Every quote must occur in the original Trigger and every enabled rule must be assessed exactly once. Inferred acceptance needs settled direction and a matched rule. Observe records `ignore` with `would_accept`, with no launch or reply. The `ignored_from_card` shortcut can only ignore, with a reason. A missing/failed assessment should return `unavailable`; delivery starts the timeout, and three delivered expiries end unavailable after two retries.

Acceptance creates an immutable Mandate and `launch` work. Subscriptions deliver later events directly through `input` work without changing authority. Human own-thread messages stay with their workers until all owners hand them back, once each with a reason. `context` subscriptions neither own messages nor resume ended Tickets. `attach` requires the message to explicitly name the Ticket. A worker cannot unsubscribe from origin or Source-bound Threads. `read` is called only after a step consumed the input and a report/turn end followed; ending releases unread messages. Full session-level read accounting and report/stage integration are S6.

`end` ends a worker round; it does not withdraw authority. A person's follow-up can resume it after current-policy revalidation, while bots cannot. `end` with `person:true` is the owner's manual stop. `stop` checks the originating human Trigger's explicit gate strength. Stopped Tickets never resume. Policy changes discard pending evaluations and notify affected live workers without cancelling their mandates.

## Stored work

Adapters claim `route`, `assess`, `launch`, `input`, `end` or `reply` work, perform it after the claim commits, then settle using the claim token. `createFabric().drain(owner, agent, handlers)` provides this boundary for in-process adapters. Handlers receive a Ticket-bound worker port: it cannot change policy, accept work, claim a human stop, or create an authoritative subscription. No model/executor adapter is enabled automatically by the feature flag: routing/assessment/worker integrations consume these ports. A rollout needs authorized adapters connected before turning Sources on; otherwise work remains durably queued, and no model calls or spend occur.

Each adapter must honor the stable idempotency key. Transport is at-least-once; a crash after sending and before settlement retries the same key. Expiring leases recover interrupted sends; stale lease tokens cannot settle newer claims. Retries start at 2 seconds and double to 60 seconds (replies: 5 to 300 seconds). Earlier work blocks later work in the same conversation. Other conversations proceed independently. Replies wait while their Source is off and drop only when its destination is no longer listened to or cannot receive. Drops retain their reason and time and cannot be requeued with the same key. Resume launches include a recovery instruction to inspect existing work before repeating outside actions.

Time belongs to `sources.js`, not assessment. A schedule is `{id, source, scope, due, text, interval_ms?}`; timestamps are epoch milliseconds. A quiet condition adds `{quiet_thread, since_trigger}`. The Source cancels it if that Thread changes before its due time. Time produces immutable system Triggers; admission requires `clock` in the Source's bot list and the scope in `receive_all`. Time never grants explicit authority. `tick` checks due conditions, expires evaluations and starts pending batches; it never sleeps or calls a model.

Account export/deletion includes the fabric aggregate. The expand-only migration adds no production writes during development. Tests name the corresponding rules from reference docs 001–003; `ov test test/fabric.test.js test/fabric-store.test.js` exercises policy, intake, persistence, ownership, routing and delivery without external services.
