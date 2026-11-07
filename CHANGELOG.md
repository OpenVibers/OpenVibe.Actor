# Changelog

What changed in OpenVibe.Actor, newest first. Each site also publishes its patch notes at /updates.

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
