# Changelog

What changed in OpenVibe.Actor, newest first. Each site also publishes its patch notes at /updates.

## Unreleased — triggers in conversation

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
