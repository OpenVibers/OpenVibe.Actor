# Changelog


## Unreleased — a notice wears the agent's face (plan §AB.31)

- **The agent on a notification:** every notice Actor sends to the Network (a step only the person can do, a task that
  finished or did not) now carries the agent it is about in `rich_content.agent`: `{ id, name, avatar_url?, hue?, glyph? }`.
  The agent is the one the task belongs to (`tasks.agent_id`, or the `agent:agt_…` it came through); a person's task
  with no agent of its own is their **Vibe**, the first agent every person has, with its face when it has one.
- Only what is safe to show travels: a name, a picture that is an https URL, a hue between 0 and 359 and a short glyph
  name. Anything else is left out, never guessed. Shared 4.251.0 draws the face; older clients show the message, which
  already reads right.

## Unreleased — the agent's files, mail and shared nodes (plan §Z.6, job 2)

- **Files (OpenVibe.Download):** `files_list` (a folder's files and folders), `files_read` (a text file of at most
  200 KB as text; a bigger or a binary file is described, with its link), and `files_save` (a file written under
  `Agent/…`, from text or from a file the task already made). The drive is reached through `openvibe-sdk/download`
  with the **person's own** token — never a sync key, never a service secret. A name that is taken gets the next
  free one ("notes.txt" → "notes (2).txt"), so nothing the agent did not make is ever overwritten.
- **Mail (OpenVibe.Mail):** `email_list` (the newest messages, at most 25, unread only if asked), `email_read` (one
  message as plain text only — never the HTML, never an attachment — framed as what it is: data from a stranger),
  and `email_draft` (a card with the draft and a link to the inbox). Mail's send is human-only, so the agent never
  sends: a draft is a draft, and the person sends it themselves.
- **Shared nodes (OpenVibe.Run):** `shared_node_check` runs a repository's own CI job on a shared node, as the job
  the checks scheduler makes (class `code`, artifact `openvibe-codes@1.0.0`, args of kind `check`), and answers the
  conclusion, the steps and the last forty lines of the log of the step that failed. Only a repository the person
  may read is run.
- Each of the three groups is a connector of the manifest (plan §Z.6), so the owner and the person switch them off
  and the daily cap counts their calls. The settings of a run (plan 11c) gate them too: a run with the files off
  never sees the file tools, and a run with the network off never sees any of the three.

## Unreleased — run settings and permission rules (plan 11c)

- **Two settings per run** beside its approval level: `files` (none, read, write; default write) and `network` (off,
  on; default on). Every tool module says what it `needs` (`{ files, network }`); a run whose settings do not give it
  leaves the tool out of the list and refuses it in one line. A task takes `settings: { files, network }`; the person's
  defaults fill the rest, and `tasks.run_settings` keeps what the run started with (migration 0074). The card's first
  steps say them ("Settings: reads your files · network on · asks before it acts").
- **Rules as data** (`server/runtime/run-policy.js`): an ordered list of `{ match: { tool, connector, risk, args },
  decision: allow | ask | deny, why }`; the last matching rule wins. The owner's list for everyone comes first and is
  final; then the person's. A deny is left out of the tools and refused with its why; an allow or an ask goes to the
  approval gate (`levels.decide({ rule })`): the floor first (money, a password, a deletion, a new recipient always
  ask), a site rule, the person's standing permission for that exact step, the person's rule, the level. An ask on a
  call the gate would not see goes through it, or is refused when nobody can be asked.
- **Unattended runs** (a schedule, a trigger Watch delivered, an agent's own routine, a run for nobody) never wait: the
  approval card stays for the person, and the step says the run goes on without it.
- **Starting points:** Careful, Balanced and Hands-off on the Settings page ("How your agent asks") write the rule list;
  files and the open web are set there too, and each rule can be removed. The owner's rules show read-only.
- **API:** `GET/PUT /api/v1/me/run-policy` (`{ files, network, rules }` or `{ preset }`), `GET/PUT
  /api/v1/admin/run-policy` (the owner's `{ rules }`).

## Unreleased — agents have souls

- **A soul** (`agents.soul@1`, Contracts 0.424.0; `openvibe-sdk/agents/soul` 0.165.0; migration 0072): who a personal
  agent is, kept apart from its instructions and its memory. `actor_agents.soul` is jsonb (null: no soul yet); a create
  and a patch take a `soul` that the SDK validates, and a catalogue answer carries it back with its `soul_md`.
- **The prompt:** a soul is the first block of a personal agent's prompt (`toPrompt(soul, { name })`) and the first
  prompt layer, before the person's instructions, so the cached prefix stays stable. It says who the agent is, never
  what it may do.
- **Import:** `POST /api/v1/agents/:id/soul/import` takes a `SOUL.md` of at most 20 KB and stores what
  `fromSoulMd` reads; an invalid result (a secret, a bad part) is 422.
- **Suggestions (Design rule 176):** `POST /api/v1/agents/:id/soul/suggest` waits in `actor_agent_proposals` as kind
  `soul` with `change()`'s words; the person accepts or dismisses it on the existing suggestions route. An agent never
  writes its own soul.
- **Your agents in the menu:** `GET /api/v1/me/agents/faces` answers each face's name, avatar, hue, glyph, state
  (working, asks, paused, resting), current step and number of asks, newest activity first and at most twelve; the
  same first-party CORS as the Actor strip, cached privately for 15 seconds.
- Pins: openvibe-contracts v0.424.0, openvibe-sdk v0.165.0.

## Unreleased — every AI call measured

- **AI meter** (`openvibe-sdk/ai-meter`, SDK 0.164.0): every model call Actor makes straight to a provider is recorded
  and sent to OpenVibe.AI's `POST /api/v1/usage/calls` (a call through OpenVibe.AI, with a person's own key or the
  router, is recorded by AI itself, so it is never counted twice): provider,
  model, task and call id, TTFT, tokens per second, latency, tokens, tool calls, the outcome, a failure's class, and
  the task's wall time on its last step. Actor's service token is narrowed to `ai.usage.report`. The meter is off in
  a drill and in tests, and it never fails or blocks a model call.
- Pins: openvibe-contracts v0.421.0, openvibe-sdk v0.164.0.

## Unreleased — make your own agent (blueprints)

- **Blueprints** (`agents.blueprint@1`, Contracts 0.419.0): a person's agent as one document of ten parts.
  - `POST /api/v1/blueprints` makes a draft, checked against the schema and `openvibe-sdk/agents/blueprint`'s rules;
    a blueprint carries no secret.
  - `PUT …/:id/draft` edits it, and `POST …/:id/publish` freezes it as version N. A published version never
    changes.
  - `GET /api/v1/blueprints` lists mine (`?scope=public` lists the gallery), and `GET …/:id?version=N` reads one
    version.
  - `POST …/:id/remix` makes a private copy that credits its source, only when the author named a licence.
- **Installs** (`agents.install@1`):
  - `GET …/:id/asks` is the install screen in words.
  - `POST …/:id/install` makes the person's own agent once every ask is agreed and the inputs are filled. Its
    instructions carry the inputs and the floor in words.
  - When a version is published, an install set to `same-or-less` takes it if it asks for no more. Any other install
    keeps it `pending`.
  - `POST /api/v1/agents/:id/install/update` takes the new version once its new asks are agreed.
- Migration 0071 adds the blueprint, version and install tables and lets an agent's instructions run to 20,000
  characters.
- Pins: openvibe-contracts v0.419.1, openvibe-sdk v0.162.0.

## Unreleased — Stop, not E-STOP

- The robot tools and page copy say Stop; `list_my_robots` no longer reads a latch field.

What changed in OpenVibe.Actor, newest first. Each site also publishes its patch notes at /updates.

## Unreleased — the same run shape as Codes and Run (`agents.run@1`, `agents.step@1`)

- **`GET /api/v1/runs`** lists the person's own runs newest first (`limit`, `before`, `status`, `agent`) in the one
  agent system's `agents.run@1` shape: owner, agent and product, parent run, budget, status, timestamps, result
  summary and cost. A task is the run; nothing new is stored.
- **`GET /api/v1/runs/:id/steps?after=`** reads the task's own event log as `agents.step@1`, one entry per output
  event, with the task event's seq as the cursor. `GET /api/v1/runs/:id` answers the same run shape when the reader
  asks for it with `Accept: application/vnd.openvibe.agents.run+json` (what `openvibe-sdk/agents` sends) or
  `?shape=agents.run@1`; the existing `agent.run@1` snapshot stays the default for its callers.
- Read-only and behind the existing `actor.task.read`/`actor.task.list`: only the person's own Network token or
  session, and another person's run is the same 404 as one that does not exist. Actor's tables are unchanged.
- The field map and what does not fit (per-step cost, Actor's `needs_you`, a tool call and its result as two log
  entries) are in OpenVibe.Contracts `docs/agents-runs.md`; the routes are in [docs/agent-runs.md](docs/agent-runs.md).
  Tests: `test/runs-api.test.js`.

## Unreleased — See it work (W1): the desk, the viewer and the replay

- **The desk tile** in a running task's card: the desk's private Live stream (started with the task's desk through Link's
  `desk.stream` and stopped with the task), with the still at 1/s when no stream is up. Under it the latest step in
  plain words, a ring where it last clicked, the browser page's address and where it is ("Your PC · its own desk",
  "OpenVibe computer"). The tile pauses its stream while off screen.
- **The viewer** (a tap on the tile): the desk fills a phone and sits beside the steps from 900 px, with Take over,
  Pause, Stop and Hand back. Take over takes a Run desk's live lease or makes Bot take the person's own input on a Link
  desk (their token, mapped to desk coordinates); the agent's input is refused while they drive. Hand back takes an
  optional note that reaches the run as the person's message. A `hand_to_person` step is an Ask that opens the viewer
  in control.
- **Replay**: every computer step keeps its still and its action. A finished task's card has a timeline to scrub, and
  each step opens the picture it saw. Typed text is redacted before it reaches the task's events, so neither the replay
  nor the task log carries it; a click keeps only its x,y.
- Migration 0070 (task stills); `GET /api/v1/tasks/:id/desks`, `/desk-still`, `/replay`, the desk take-over/hand-back
  and the person's input. Tests: `test/see-it-work.test.js`; screenshots: `test/see-it-work-shots.js`.

## Unreleased — the chat is the one place you use Actor (one agent system, stage 1)

- **Composer v2** (openvibe-shared 4.215.0, the `agent` preset): the chat mounts `OpenVibeComposer.mount` with Attach,
  Speak, the mode chip (Fast, Balanced, Best, Cheapest, Private) and the round send; files go through Actor's existing
  path (`POST /chat` with the file as data) and their chips show the read's progress. The dashed "Attach files" box and
  the separate model/mode controls are gone; the model lives at `/chat/model`.
- **Settings** (`/chat/settings`): the run defaults ("New runs: Only me … Apply to all my existing runs") moved off the
  chat. The route (`POST /chat/defaults`) and its behaviour are unchanged.
- **Four suggestion chips** on an empty chat, one line each, instead of the wall of starter cards; a chat with messages
  shows none.
- **The Console is folded in**: `/console` answers 301 to `/chat` (carrying `?ask=`/`?from=`), the bottom tab bar is
  Home, Chat, Agents, and the running tasks the Console listed are the chat's "Now" strip — one line each, Stop on each,
  hidden when nothing runs. `/me/spend` and the approvals, agents, computers and robots APIs and pages stay.
- **A running task is a card in the conversation** (title, state, the last steps, Stop), refreshed in place from
  `GET /chat/turn/:id`; stopping goes through `POST /chat/:id/cancel` and returns to the chat.
- Migration-free. Tests: `test/one-page.test.js`, plus the updated chat, console, model, sharing, allowance and
  self-host suites; screenshots at 390 and 1280: `test/one-page-shots.js`.

## Unreleased — skills that run code, sandboxed (HO8 step 3)

- **`actor.skill@2`: code in a sandbox** (plan HO8, ADR-060; contracts 0.343.0): a sandbox skill carries one to five
  tools and its code as ordinary `.js` text resources. The registry reads the code, never runs it, and fails a tool
  that reads `process.env`, starts a process, worker or `vm`, writes a file, builds code at run time, requires anything
  but Link's safe modules, carries an encoded blob or minified code, or reaches the network outside the `net` its tool
  declares; it flags any network use, timers over 5 s and loops over input. Every finding names its tool. The
  cross-field rules (a tool's entry is a resource, every code resource is a tool's entry, tool names are unique) are
  checked before anything is listed.
- **The bytes that run are the bytes that were scanned**: publishing a sandbox skill stores each code resource as a
  private OpenVibe.Media object under Actor's tenant and pins `{ name, media_id, sha256 }` on the
  `actor.skill-listing@2`; `server/skills/publish` is the registry's path (a prompt skill stays `actor.skill@1`).
- **`skill.run`**: a new HO1 kind ("running a skill's code in a sandbox"), allowable, with the exact target
  `<slug>@<version> <tool>` (plus ` · internet` when `net` is `public`), so "always allow" covers one version's tool.
- **The tool the agent calls**: each installed sandbox tool becomes a runtime function whose description is the tool's
  words plus its network in plain language and whose input is the tool's `args` schema; a bad input never becomes a
  job. A run is one OpenVibe.Run function job as the person (`X-OV-Subject` + `X-OV-Project`), artifact
  `openvibe-skill-runner@1.0.0`, the pinned inputs, the declared `net` and limits (never above the caps), `ttl_ms`
  120000, and the person's own machines before OpenVibe's pool. No node: a plain message and Link's "Run it on my
  machine" link, and nothing runs anywhere else. The tool's JSON comes back as untrusted data, cut to 64 KiB, with the
  job id, wall time and exit; Run's per-second metering is the cost.
- **The card and install page** say "Runs code in a sandbox on your machine or OpenVibe's", list each tool with its
  network in plain words ("no internet", "OpenVibe sites only", "the internet") and its limits, and show the scan's
  findings per tool. A flagged code skill installs only after the person reads them; a failed one never.
- Migration 0047 (`actor_skill_listings.code`, the document's own text, the `skill.run` kind). Tests:
  `test/skill-sandbox.test.js`.

## Unreleased — an agent's live canvas (HO9)

- **An agent's live panel beside the conversation** (plan track HO, wave 2; ADR-059, `actor.canvas@1`): the agent calls
  `canvas_set({ title, blocks })` and the panel is drawn beside its thread — a trip board, a price table, a checklist, a
  small chart — from data only (no HTML, no style, no script). The whole document is replaced and its version grows;
  it is validated against the released contract, and a picture outside openvibe.media, a markup block or another
  block the contract does not know is refused with the schema's plain reason and nothing is written. One run may call
  it at most 20 times. The panel lives in `actor_canvases`: one row per conversation (the thread's first turn), with
  the document, its version and the ticks waiting for the next turn (migration 0045).
- **The person's moves, never the canvas's**: a button's label is posted by the API as the person's own message — a
  normal turn from the newest turn of the conversation, at the agent's level and through its approvals, exactly as
  typing it would (nothing else happens). A checklist tick flips that item in the document (version + 1) and starts
  no turn; the next turn is told which item the person ticked, once, as its conversation context. Both go through the
  same-origin API (`GET /api/v1/me/canvases?thread=`, `GET /api/v1/me/canvases/:id`,
  `POST /api/v1/me/canvases/:id/events`) and another person's canvas is the same 404 as one that does not exist.
- **Where it shows**: the thread page draws it in the third column on a wide screen and as one closed "Canvas · N
  items" bar above the composer on a phone (open on tap; the open body scrolls inside at 45vh), with openvibe-shared
  v4.145.0's ov-canvas.js. The page redraws it from the thread's live events when `canvas_set` runs; a closed bar
  still updates its count and says "updated" for a few seconds. The document is in the account export and goes with
  the account. Test: `test/canvas.test.js`; openvibe-contracts v0.341.0 names the routes.
- **Chat can draw it beside a Vibe chat** (HO9 step 2): the two reads answer a cross-origin request from
  `https://openvibe.chat` only, with the person's own Network Bearer and no credentials mode (a cookie from another
  site is refused), and carry `Vary: Origin`; every canvas write stays same-origin. Test: `test/canvas.test.js`.

## Unreleased — the skills registry (plan HO2)

- **A skill is a document, and the registry vouches for it** (plan HO2, ADR-058; contracts 0.340.0): `actor.skill@1`
  is a slug, a name, a one-line description, a version, Markdown instructions, up to ten text resources and what it may
  ask an agent to do. It runs as a prompt and nothing else — no code, no binary, no install recipe — and it grants
  nothing: the agent's level and its approvals still decide every step. The document's integrity hash is not a
  signature (as for an agent's voice): the author in a document is a claim, and the listing is the only place a
  publisher is vouched for.
- **The scan comes first** (`server/skills/scan.js`): deterministic, no model, five rules over the words of the
  document — an act of a kind the skill did not declare, a request for a password, a key, a token or a seed phrase,
  files or notes sent to an address or a URL, a resource that reads as a script, a URL outside the hosts it declared.
  A block fails the skill (it never installs), a warning flags it (the person reads the findings and confirms), no
  finding passes it (it installs in one tap).
- **OpenVibe's own skills first** (`skills/`): four real documents — a stream recording's summary with its moments,
  the last seven days as a changelog draft, a price watch as a goal, a research brief with its sources — published as
  listings of publisher kind `openvibe`. Nobody may upload a skill in this wave.
- **Progressive disclosure**: an agent's prompt carries each installed skill's name and description only; the tool
  `load_skill(slug)` brings the instructions and the resources, framed as guidance from that skill. A skill changes no
  level and no approval.
- **The pages**: `/skills` (the catalogue, the scan's state in words) and `/skills/<slug>` (the instructions, what it
  may ask for in plain words, the findings, and the install). The agent's page lists its own skills, with Remove.
  `GET /api/v1/skills` and `GET /api/v1/skills/:id` answer the listing; `POST/DELETE /api/v1/me/agents/:id/skills`
  install and remove.
- **The curator ships with the catalogue**: a listing nobody has loaded for 30 days goes stale, for 90 days it is
  archived, and a stale or archived listing is not offered. The job asks at night what is due; it is off in a drill.
- Migration 0043 (`actor_skill_listings`, `actor_skill_installs`). Both tables go with the person: an account export
  carries the installs, and an account deletion erases them. Test: `test/skills.test.js`.

## Unreleased — memory that tidies itself (HO5)

- **An agent's memory that consolidates itself** (plan track HO, wave 2): once a person turns on "Tidy my agents' memory
  each night" on /memory, one due-based job runs each due agent's own notes through ONE model call a night, in the
  cheapest class that can wait (OpenVibe.AI's `batch`, or `background` when the client cannot ask for batch), and the
  answer is DATA: a list of merges, retires and promotions and a short diary, checked against the agent's own notes
  before anything happens. The sources of a merge are kept and marked `merged_into`, a stale note is marked
  `retired_at` and never deleted, a note that keeps coming up becomes a pinned note and the agent reads pinned notes
  first, and the diary is two to five plain sentences in the agent's voice (migration 0041).
- **The rules the model cannot break**: only the agent's own notes are touched — a note the person wrote, or pinned by
  hand, is left alone; every id in the answer must be one of the notes that were sent, so an id from another agent or
  another person is ignored; a merge longer than its sources together is refused; at most 20 changes a night, per
  person; and the person's own words still make the only active memory.
- **The person sees it and corrects it**: /memory and the agent's page show the latest diary entry and every change,
  each with Undo for thirty days (an undo brings the sources back and drops the merged note). A diary entry can be
  edited or deleted, and a note can be pinned by hand.
- **Consent and the job**: the setting is off by default and lives in a row per person with a `next_due_at` (never a
  weekly interval in the code); nothing runs for a person who has not turned it on, and the job is off in a drill and in
  a test. The diary and the history of the nights are in the account export and go with the account (ADR-033).
  Test: `test/memory-tidy.test.js`.
## Unreleased — triggers in conversation

- **The routine's card in the chat** (Opus): the turn that made a trigger shows it — when, in words (with its zone),
  what runs, the next run in the reader's own time, how the last run went (a link to it), which agent runs it, and On,
  Paused or Deleted. Its moves are plain forms that work with no script: Pause or Resume, Run now, and Undo for ten
  minutes, then Delete with a confirmation; a routine paused after failed runs says so and leads with Resume. Only the
  turn's requester, same-origin, and only a trigger that turn made (`POST /chat/:id/trigger/:tid`); Watch is called with
  the person's session. Schedules read the way a person says them: "Every hour at :30" (was "Every 30 minutes"),
  "Every 15 minutes", "Every 6 hours", "Every day at 08:00 and 20:00", "Every month on the 1st at 09:00", "Every year
  on 25 December at 09:00"; a rule with no plain phrase is "On a custom schedule, <cron>". Test: `test/trigger-card.test.js`.
- **Triggers made in the conversation** (plan §12 A-4): `schedule_trigger` turns "every weekday at 9, summarise my inbox"
  or "when a new issue lands in my repo, triage it" into a Watch subscription the person owns, created with their own
  token — never Actor's service token acting for them. The tool parses the sentence, and when it cannot (no time, no
  timezone, two times, no event it can name) it makes nothing and asks the one question instead. The card is a
  `trigger` step on the turn: when in words and cron, what it runs, the next run, the last result (ok, failed, needs
  you) and active/paused (migration 0037).
- **The person's moves** are Actor routes: `GET/POST /api/v1/triggers`, `PATCH /api/v1/triggers/:id`, `…/pause`,
  `…/resume`, `…/run` and `DELETE` (undo for ten minutes, then Delete with a confirmation). Another person gets 404.
  At most 20 active triggers, the smallest interval is 15 minutes, and five failed runs in a row pause the trigger and
  say so on the card.
- **Watch runs come back as assignment roots** with origin `routine` and the trigger's own level, capped there: a
  routine cannot borrow a higher standing level from its agent. Money, passwords, deletions and new recipients still
  always ask inside the run.
- Watch gets the routine's cron (`POST /api/v1/watches/:id/schedule`), a scheduled check that queues the action without
  fetching, and its own five-failed-check pause; an actor-agent delivery now names the watch and the Actor trigger.
- Contracts 0.330.0 adds `actor.trigger@1` and the `trigger` step on `actor.task-event@2`; Actor still pins 0.328.0
  until it is released, so the routes are guarded by `actor.task.read`/`actor.task.create` in the meantime.

## Unreleased — one Computer

- **One Computer** (plan 2026-11-07: "Surf, Computer and Actor are one experience"): when a task opens a desk, its
  own step carries `computer` (`session_id` — OpenVibe.Run's `ses_…`, or null on the person's own machine through
  Bot — `machine`, `where` and `cost_hint`) from the tool's answer, never the model's words. `GET /api/v1/tasks/:id`
  reads the same object off the task's own steps, with `driving` while the person holds the desk, and
  `agent.timeline-entry@1` stores it (migration 0035).
- **Take over / Give it back** are one API on the task: `POST /api/v1/tasks/:id/takeover` and `…/giveback`, built on
  the `hand_to_person` hand-off. While the person drives, `computer_input` and the acting `computer_browser` actions
  are refused with a clear reason; the task's timeline gets one `handoff` step and the Dock's timeline one step with
  the same Computer. Only the task's own person.
- **The still**: `GET /api/v1/tasks/:id/still` asks the session's own service (Run) for the newest frame as Actor's
  service token acting for the person, and answers the bytes with `Cache-Control: private, no-store`. A person's
  task only; another person, a signed-out visitor and an app token all get the same 404 as a missing task.

## 0.3.0 — 2026-11-07

- **Space's builder as a task of the person's one agent** (plan 2026-10-22 §Z, stage Z1): six new tools — `space_create`, `space_files_list`, `space_files_read`, `space_files_write`, `space_preview` and `space_publish`. The agent works on the person's own spaces through OpenVibe.Space's builder API (`/api/v1/builder/spaces`), as the person: another person's space is the same 404 as one that does not exist, and every write goes through the same path, limits and audit as Space's own editor.
- **Publishing waits for the person:** `space_publish` asks, and the answer lives in the Dock ("Needs you"); the tool says the space is not published yet until the person says yes.

## 0.2.0 — 2026-11-07

- **The one timeline behind the Dock** (design 2026-11-07): every mode of the agent (Chat, Codes, Run, Watch, Live, Surf) publishes the step it took as agent.step.started|updated|ended, and Actor keeps the one timeline: GET /api/v1/agent/timeline (cursor, mode and needs-you filters, the per-mode counts) and the live stream GET /api/v1/agent/timeline/stream. An entry is a title, an outcome and a link: the table has no column for a prompt or a diff, so none can be stored.
- **Needs you and the kill switch:** POST /api/v1/agent/approvals/:product/:id/decide answers an approval in the mode that owns it (the person's own token goes with it), and POST /api/v1/agent/kill-switch stops what is open and pauses the agent until the person resumes it.
- **Only me by default:** an entry is private until the person shares it through the one Share sheet; another person's entry is the same 404 as one that does not exist. The timeline is in the account export and goes with the person on deletion.

## 0.1.0 — 2026-10-08

- **First release:** the task router (plan T17, ADR-044). A task is classified, routed by `openvibe-sdk/placement`, run, checked by a second model family, and delivered as `platform.task@1` with its cost and explanation.
- **Agents:** the OpenVibe runtime (DeepSeek acting through OpenVibe.Search and OpenVibe.Tools), OpenAI's web agent, and an open model on OpenVibe's server for private mode. OpenVibe.Codes is listed for coding.
- **API:** tasks, a live stream, cancel, the agent catalog and a dry-run router. Capabilities: `actor.task.create`, `actor.task.read`, `actor.task.list`, `actor.agent.read` (openvibe-contracts 0.115.0).
- **Money:** a free tier per person and an operator daily ceiling. Budgets are hard.
