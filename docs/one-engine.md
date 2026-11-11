# One engine: first slice

Products that need an assistant answer submit a turn to Actor. Actor owns model selection, tool execution, safety
checks, metering, and the durable task history. A product owns its surface and its domain record, then links that
record to the Actor task. This slice is Exchange's companions and Chat's support inboxes.

## The turn call

One call, `POST /api/v1/tasks` on OpenVibe.Actor, then `GET /api/v1/tasks/:id` until the task ends.

The body is `actor.task-create-request@1` plus three optional fields this slice adds:

- `conversation`: `{ product, id }` — which product conversation the task answers. Stored on the task row, so a later
  query finds the turn's task.
- `tools`: the registry tool names the run may call. An empty array answers with no tool calls. A name the registry
  does not offer is said aloud in the run's plan, never silently dropped.
- `model`: one exact model id, resolved by OpenVibe.AI like one the person picked themselves.
- `tier`: the content tier, `standard` or `uncensored`.

Alongside the words, the body carries `budget.per_task_usd` (what this one turn may cost) and an
`idempotency_key`, so a repeat of the same turn is the same task and a different turn is refused with
`409 actor.idempotency.conflict` rather than answered twice.

## The content tier

The uncensored tier is OpenVibe.AI's, and AI is the one that decides it. A turn that asks for it must name
the person it is for; Actor refuses such a turn with `422 actor.tier.no_person` when it names nobody, so an
anonymous visitor's turn can never ask for the adult tier. The tier then rides every model call of the run as
a control field on AI's run, alongside `on_behalf_of`. AI reads it (`server/runs.js`), checks the named
person's 18+ confirmation on the account (`server/policy/adult-status.js`, a five-minute cache, failing
closed) and refuses the tier without it, in words. The hard floor — nothing sexual involving a minor — is
checked on the request, the answer and every streamed chunk, on every tier, and it never moves.

Actor never sends the tier to a provider directly: the adult tier runs on AI, and a server without AI
configured refuses it (`actor.tier.unavailable`) rather than quietly answering on the standard tier.

## Who the turn is for, and who pays

Two callers exist in this slice, and they are not the same.

**A signed-in person's own turn.** The caller sends that person's own Network bearer token, audience
`openvibe.actor`. Actor reads the person from the token itself. Nothing is exchanged and nobody is impersonated.

**A first-party product acting for a person.** A product that holds the person's session (Exchange's companions)
sends the person's own bearer token. A product that does not hold one — Chat's inbox answers, where a visitor may
be anonymous — sends Chat's own service token with `X-OV-Subject: usr_…` naming the person. Actor accepts that
only for a first-party service token (`sub` begins `svc:` and `actor_type` is `service`); a developer app or an
agent may not name a person this way. The task is then the person's: their allowance pays for it, it appears in
their task list, and Actor records the service as `via`.

**A turn with no person.** An anonymous visitor has no account, so the turn is the product's own: the service
token goes out with no `X-OV-Subject`, and the cost comes from the operator's cap. A service never borrows an
account for somebody who has none.

Example: Exchange companion `cmp_chat_123`, turn `turn_456`, submits its assembled system context and current
history plus "Help me plan a quiet weekend." The allowed tools are empty for this plain companion answer, and its
per-turn ceiling is the companion's configured maximum. The task is owned and charged to the signed-in person's
Actor budget. Exchange stores the task id and renders Actor's answer, cost, refusal, or outage in its existing
receipt and error slots.

Example: Chat's support inbox, conversation `cnv_…`, visitor signed in as `usr_…`, asks "Where is my order?" The
turn carries the inbox's instructions and pages, the conversation so far, and the visitor's words, with the tools
`read_page` (the inbox owner's own pages) and `time_in`. The visitor's subject id rides in `X-OV-Subject`, so the
turn is theirs and their allowance pays for it. An anonymous visitor's turn carries no subject: it is Chat's own
turn on Chat's cap.

## Shared history

Each product stores the Actor task id beside its conversation turn. The task is the canonical answer, event stream,
and cost record; another authorized site reads it through Actor's `actor.task.read` API using that person's own
token. Product-specific context and messages remain in their domain store until a later migration makes Actor the
conversation store. No copied model transcript becomes a second canonical history.

A turn still running when the caller's wait ends is stored pending with the task id; the next view reads the task
back and fills the answer in. The words the visitor sees in the meantime say the answer is coming.

## Failure behavior

If Actor refuses the turn, the product shows Actor's refusal in plain words. If Actor is unavailable, the product
says the assistant could not answer right now and offers its existing human handoff or retry. It never retries
through OpenVibe.AI or another engine silently, and it never charges the visitor twice for a turn that did not
answer.

## What this slice does not do

- **The inbox's own actions.** A support inbox's `action_*` tools call the owner's own systems from Chat, signed
  with the action's secret. They stay a Chat-side tool until Actor can call them.
- **Pictures.** A turn is words, so a visitor's picture travels as its link and a note saying it is there.
- **Sampling.** A chat's temperature and preset stay saved on the chat; the loop's own sampling applies until a
  later slice carries them.

## Next slices

1. Move Vibe room conversations onto Actor tasks, retaining the room UI and its authorization rules.
2. Direct coding tasks can use Actor's shared loop and `codes_task` when the owner sets `ACTOR_UNIFIED_CODE_RUNS=1`. Codes still executes the file changes on the person's machine. Scheduled personal agents already use the shared loop. The switch defaults off while the owner checks the new path in production.
3. Let the inbox's actions ride a turn, so a visitor's order question is answered by the owner's own system.

When Chat starts one of its manager's personal agents as a channel member, the run keeps `via=agent:<id>` for the agent's memory and daily cap. Actor records `delegated_via=service:chat` on that task only, so Chat can follow its result and bring it back to the room. Other services and Chat's own unrelated tasks stay outside that read grant.
