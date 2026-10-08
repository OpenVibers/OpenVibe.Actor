# Changelog

What changed in OpenVibe.Actor, newest first. Each site also publishes its patch notes at /updates.

## 0.1.0 — 2026-10-08

- **First release:** the task router (plan T17, ADR-044). A task is classified, routed by `openvibe-sdk/placement`, run, checked by a second model family, and delivered as `platform.task@1` with its cost and explanation.
- **Agents:** the OpenVibe runtime (DeepSeek acting through OpenVibe.Search and OpenVibe.Tools), OpenAI's web agent, and an open model on OpenVibe's server for private mode. OpenVibe.Codes is listed for coding.
- **API:** tasks, a live stream, cancel, the agent catalog and a dry-run router. Capabilities: `actor.task.create`, `actor.task.read`, `actor.task.list`, `actor.agent.read` (openvibe-contracts 0.115.0).
- **Money:** a free tier per person and an operator daily ceiling. Budgets are hard.
