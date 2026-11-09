# Your Actor (A1 and A2)

`/api/v1/me/actor` is the backend for the Actor page and the Dock. Every route needs the person's own Network token, a scoped Network Dock token, or their same-origin Actor session. Dock reads require `actor.me.read`; writes require `actor.me.write`. First-party CORS accepts bearer credentials only, including preflight, and never enables cookies. Service credentials cannot turn someone else's Actor on or answer an Ask. Creating settings or goals never starts work. POST `resume` is the explicit opt-in; POST `pause` cancels the current slice, including a parked slice, and stops future slices.

The expand migration `0055_personal_actor.sql` follows `0054_actor_device_answers.sql`. There is no destructive migration. The new rows participate in account export/deletion. No existing agent, trigger or task is converted or switched on.

## API

All paths below start with `/api/v1/me/actor`.

| Method and path | Body or response |
| --- | --- |
| GET `/` | Actor settings plus `now: {current_step, looking_at, last_three_steps, next, cost_today}` and pending asks |
| PATCH `/` | Any of `name`, `avatar` (`{media_id}` or null for the person's picture), `brain` (`auto`, `openvibe`, `own:<provider>`, or a catalogue id), `computer`, `caps`, `adult_opt_in` |
| GET `/models` | `models` beginning with Auto, then the existing AI/Exchange catalogue |
| GET `/lanes` | The eight lane templates, default asks-before list, daily budget and allowed tools |
| GET, POST `/goals` | List or create goals; creation needs `text` and `lane` |
| PATCH, DELETE `/goals/:id` | Edit or retire a goal; deleting also cancels that goal's active slice |
| GET `/asks` | Pending `actor.ask@1` records; `?all=true` includes past asks |
| POST `/asks/:id/answer` | `{text}` for a question, `{}` to approve an action or confirm a manual step |
| POST `/asks/:id/decline` | Decline this exact step; it cannot be reused as approval |
| GET `/journal?before=…&limit=30` | `{items,next_cursor}`; cursor is the last row id; at most 100 rows |
| POST `/tell` | `{text,attachments?:[{name,text}]}`; saved for the next step, including across restarts or while paused |
| POST `/pause`, `/resume` | `{}`; return the current Actor |

`computer` is `{kind:'none'}`, `{kind:'link', machine_id:'dev_…'}`, or `{kind:'openvibe'}`. A named Link computer cannot silently fall back to another machine. OpenVibe selection opens a Run computer rather than trying the person's Link machines first. Actual computer access still goes through the existing owner checks.

`caps` is `{usd,minutes,balance_floor_usd}`. A goal's `budget` is `{usd,minutes}`. Goal fields also include `asks_before` (plain strings, defaulting to the lane table), `enabled`, `every_minutes` (default 1440, minimum 5), and `next_due_at` (ISO timestamp, default now). Limits use UTC days; actual model spend and active minutes are booked to the day they occur, including runs that wait across midnight. Computer and cap changes require pausing first. Brain changes apply from the next model call, including a per-goal `brain_override`. A goal may have `{days:[0..6],start:0..23,end:1..24,zone:IANA}` as `schedule`; normal due checks honor that window. “Do it now” bypasses the window once while preserving caps and the on/off setting. A null stored avatar is returned as `{person:'usr_…'}` for the consumer to resolve through the existing person profile.

## Running and waiting

The Jobs timeout chain checks persistent due dates every 15 seconds, with its first check one second after startup. It is disabled in tests and drills. Starting a slice locks the person's Actor under the existing task spending transaction and rechecks the earliest affordable goal. One active task per Actor and persisted reservations prevent two ticks from claiming the same money or time. The per-task timeout is limited to the minutes left for both the Actor and goal. Between slices it rests for at least a minute; the goal's next due time is persisted at creation. The next prompt includes recent journal entries and the person's queued messages, and asks for progress, lessons and the next useful step.

The balance floor is applied to Actor's current spendable daily allowance, the same balance its existing task engine uses. That engine still uses the free allowance, not Billing wallet debits. No separate paid wallet is invented here. Finished slices release their unused reservations; parked slices retain their reservation but accrue no active minutes while waiting. The existing v2 engine meters actual model cost, so as with other v2 tasks, a provider's final call may exceed an estimate.

Saved runs must be configured (`ACTOR_CHECKPOINT_KEY`, the existing checkpoint setting) before resume is accepted. Questions and manual steps use `ask_person`; consequential tools create an exact-action approval before executing. All consequential actions ask in this first version, including those outside the lane's default list. A smaller asks-before list cannot bypass this guard. Briefing and deal-watch lanes do not receive computer or coding tools. Connected arbitrary tools are not offered to day goals.

Asks reuse A2 waits. The checkpoint and remaining time are written before an answer can wake the run. Answers are durable, are replayed as untrusted data, and survive a process restart between answering and resuming. An action approval is consumed atomically for its exact tool and canonical arguments, once. A decline never runs the action. Each new Ask uses the existing Network notification client and `network.notifications.push` grant. Notifications follow the existing best-effort, at-most-once policy. Unanswered asks expire after six hours and stop that slice.

Journal entries are private to the owner. Screenshots are resized to 320-pixel WebP thumbnails in the existing private task artifact store, with authenticated artifact URLs. Tool payloads and raw page HTML are not copied into the journal. The `actor.ask@1` schema is introduced in Contracts PR #365; these API objects already have that shape without pinning Actor to an unreleased library tag.


## Actor page and saved sign-ins

`GET /you` uses the shared kit and thread components. It renders Now, Asks, Tell it, Today, Goals, Money, Computer and the Brain sheet. `0056_actor_page.sql` adds schedules, per-goal model choice, message attachments and confirmed earnings without changing existing rows.

Additional page APIs: `GET /page`, `POST /do-now` (`{goal?}`), `POST /earnings` (`{text,usd,confirmed:true}`), `GET /sites`, `DELETE /sites/:site`, `GET /computer-log`, `GET /computer/still`, and `POST /computer/:action` (`take`, `back`, `input`, `save`). Each uses the same owner/scoped-Dock guard. The screen uses Run's authenticated stills and owner control endpoints. Computer time and take-overs come from Run; settled computer charges link to the Network wallet. Catalogue token prices are displayed when an hourly price is not supplied. Existing Codes connections are linked under Your plans.

For an OpenVibe computer, `hand_to_person` creates a `sign_in` Ask and keeps the Run session while the task is parked. “Done” saves the profile and hands control back before recording the answer. A new session restores the same Actor's encrypted cookies and local storage. Sign-out clears the exact listed site's stored and live browser data. Run requires its existing durable signing key; it refuses saved profiles with an ephemeral key. Profiles are encrypted with authenticated owner/Actor binding and removed on account deletion. The bounded snapshot is at most 47 KB; an oversized save fails visibly rather than silently dropping sign-ins.

Companion reviews: Contracts #365, Network #703, Run #217, Bot #347, Node #144. Run migration is `0017_actor_browser_profiles.sql` after Link address support's 0016; Network adds scopes in 0060 after reserved 0059. Deploy the profile protocol together across Actor, Run, Bot and Link.
