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
