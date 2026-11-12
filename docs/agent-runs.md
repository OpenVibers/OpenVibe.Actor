# Agent run streams

`GET /api/v1/runs/:id` returns an `agent.run@1` snapshot. A task ID selects its latest run;
the returned `id` (`task-id~starting-event-sequence`) pins the run across retries.
`GET /api/v1/runs/:id/events` streams AG-UI with numeric SSE `id`, `event` type and JSON `data`.
Reconnect with `Last-Event-ID`. Keep-alive comments keep connections open; RUN_FINISHED/RUN_ERROR closes them.
Both endpoints use the task routes' actor.task.read, owner/delegation and rate/budget checks.

The owner switch is `agentRuns` in `actor.ai` (`/internal/config/actor.ai`); it starts off.
`ACTOR_AGENT_UI=1` or `0` pins it. Enable the setting after checking production; the stored setting then becomes
the site's default and can be changed live. The view remains in Shared.

Task events project into PostgreSQL under a per-run lock. The projection stores its exact sequence, titles, groups,
plan, sources and tool state, so restarts and concurrent readers replay identical events. Extra full redacted tool
results and arguments are stored separately from the existing actor.task-event body, preserving that contract.
Tools use a title table first; unknown tools use a cached, bounded small-model request through OpenVibe.Exchange,
with only the redacted tool and target. If no small model or credentials are available the title is “Performed an action”.
Result events retain full redacted output and carry a one-line summary. Web results provide deduplicated HTTPS sources
with titles. Historical clipped outputs cannot be recovered. Approvals emit ov.approval with the existing review link.

Grouping, one-line summaries and step status are carried in `metadata["ov.step"]`; the reserved `metadata.ov`
contains the contract's title, kind, sources, attachments, cost, needs_you, product and ref fields.

## The one agent system's shape (`agents.run@1`, `agents.step@1`)

The same run also answers in the Contracts shape every agent product uses (OpenVibe.Contracts `docs/agents-runs.md`
maps Actor's `tasks`/`task_events` field by field):

- `GET /api/v1/runs` — the person's own runs, newest first (`limit`, `before`, `status`, `agent`), `{ runs, next }`.
  A run is `agents.run@1`: `id`, `owner`, `agent { id, name?, product: "actor" }`, `parent_run`, `budget` (USD and
  the timeout in seconds), `status` (`planning|running|waiting|done|failed|stopped`), `created_at`, `updated_at`,
  `result_summary` and `cost`.
- `GET /api/v1/runs/:id` — the older `agent.run@1` snapshot stays the default. A reader asks for the new shape with
  `Accept: application/vnd.openvibe.agents.run+json` (what `openvibe-sdk/agents` `runs.get` sends) or
  `?shape=agents.run@1`.
- `GET /api/v1/runs/:id/steps?after=N` — the task's own event log as `agents.step@1`, one entry per output event
  (`run_id`, `seq`, `kind think|tool|message|child|file`, `text`, `tool_call`, `result`, `started_at`, `ended_at`),
  `{ run_id, steps, next }`. `seq` is the task event's own and is never renumbered, so `after` is the same cursor a
  reconnect uses.

All three are read-only and use the task routes' `actor.task.read`/`actor.task.list`; only the person's own Network
token (or this site's session) is accepted, and anyone else — including an app's own token — gets the same 404 as a
run that does not exist. Actor's tables are unchanged. The event log splits a tool call and its result into two
entries; both become `kind: tool`, the call's entry has `tool_call`, the result's has `result`.
