# One Actor per person (A1)

`/api/v1/me/actor` is the backend for the Actor page and the Dock. Every route needs the person's own Network token or their same-origin Actor session. Service credentials cannot turn someone else's Actor on or answer an Ask. Creating settings or goals never starts work. POST `resume` is the explicit opt-in; POST `pause` cancels the current slice, including a parked slice, and stops future slices.

The expand migration `0055_personal_actor.sql` follows `0054_actor_device_answers.sql`. There is no destructive migration. The new rows participate in account export/deletion. No existing agent, trigger or task is converted or switched on.

## API

All paths below start with `/api/v1/me/actor`.

| Method and path | Body or response |
| --- | --- |
| GET `/` | Actor settings plus `now: {current_step, looking_at, last_three_steps, next, cost_today}` and pending asks |
| PATCH `/` | Any of `name`, `avatar` (`{media_id}` or null for the person's picture), `brain` (`auto` or a catalogue id), `computer`, `caps` |
| GET `/models` | `models` beginning with Auto, then the existing AI/Exchange catalogue |
| GET `/lanes` | The eight lane templates, default asks-before list, daily budget and allowed tools |
| GET, POST `/goals` | List or create goals; creation needs `text` and `lane` |
| PATCH, DELETE `/goals/:id` | Edit or retire a goal; deleting also cancels that goal's active slice |
| GET `/asks` | Pending `actor.ask@1` records; `?all=true` includes past asks |
| POST `/asks/:id/answer` | `{text}` for a question, `{}` to approve an action or confirm a manual step |
| POST `/asks/:id/decline` | Decline this exact step; it cannot be reused as approval |
| GET `/journal?before=…&limit=30` | `{items,next_cursor}`; cursor is the last row id; at most 100 rows |
| POST `/tell` | `{text}`; saved for the next slice, including when paused or waiting |
| POST `/pause`, `/resume` | `{}`; return the current Actor |

`computer` is `{kind:'none'}`, `{kind:'link', machine_id:'dev_…'}`, or `{kind:'openvibe'}`. A named Link computer cannot silently fall back to another machine. OpenVibe selection opens a Run computer rather than trying the person's Link machines first. Actual computer access still goes through the existing owner checks.

`caps` is `{usd,minutes,balance_floor_usd}`. A goal's `budget` is `{usd,minutes}`. Goal fields also include `asks_before` (plain strings, defaulting to the lane table), `enabled`, `every_minutes` (default 1440, minimum 5), and `next_due_at` (ISO timestamp, default now). Limits use UTC days. Settings cannot change during an active slice: pause first. A null stored avatar is returned as `{person:'usr_…'}` for the consumer to resolve through the existing person profile.

## Running and waiting

The Jobs timeout chain checks persistent due dates every 15 seconds, with its first check one second after startup. It is disabled in tests and drills. Starting a slice locks the person's Actor under the existing task spending transaction and rechecks the earliest affordable goal. One active task per Actor and persisted reservations prevent two ticks from claiming the same money or time. The per-task timeout is limited to the minutes left for both the Actor and goal. Between slices it rests for at least a minute; the goal's next due time is persisted at creation. The next prompt includes recent journal entries and the person's queued messages, and asks for progress, lessons and the next useful step.

The balance floor is applied to Actor's current spendable daily allowance, the same balance its existing task engine uses. That engine still uses the free allowance, not Billing wallet debits. No separate paid wallet is invented here. Finished slices release their unused reservations; parked slices retain their reservation but accrue no active minutes while waiting. The existing v2 engine meters actual model cost, so as with other v2 tasks, a provider's final call may exceed an estimate.

Saved runs must be configured (`ACTOR_CHECKPOINT_KEY`, the existing checkpoint setting) before resume is accepted. Questions and manual steps use `ask_person`; consequential tools create an exact-action approval before executing. All consequential actions ask in this first version, including those outside the lane's default list. A smaller asks-before list cannot bypass this guard. Briefing and deal-watch lanes do not receive computer or coding tools. Connected arbitrary tools are not offered to day goals.

Asks reuse A2 waits. The checkpoint and remaining time are written before an answer can wake the run. Answers are durable, are replayed as untrusted data, and survive a process restart between answering and resuming. An action approval is consumed atomically for its exact tool and canonical arguments, once. A decline never runs the action. Each new Ask uses the existing Network notification client and `network.notifications.push` grant. Notifications follow the existing best-effort, at-most-once policy. Unanswered asks expire after six hours and stop that slice.

Journal entries are private to the owner. Screenshots are resized to 320-pixel WebP thumbnails in the existing private task artifact store, with authenticated artifact URLs. Tool payloads and raw page HTML are not copied into the journal. The `actor.ask@1` schema is introduced in Contracts PR #365; these API objects already have that shape without pinning Actor to an unreleased library tag.
