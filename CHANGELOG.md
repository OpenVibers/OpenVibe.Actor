# Changelog

What changed in OpenVibe.Actor, newest first. Each site also publishes its patch notes at /updates.

## Unreleased — skills that run code, sandboxed (HO8 step 3)

- **`actor.skill@2`: code in a sandbox** (plan HO8, ADR-060; contracts 0.343.0): a sandbox skill carries one to five
  tools and its code as ordinary `.js` text resources. The registry reads the code, never runs it, and fails a tool
  that reads `process.env`, starts a process, worker or `vm`, writes a file, builds code at run time, requires anything
  but Node's safe modules, carries an encoded blob or minified code, or reaches the network outside the `net` its tool
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
