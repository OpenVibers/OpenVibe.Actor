# Tool batches and full memories — 2026-11-23

Baseline: `c97e624` on `origin/main`. Fourteen new regression scenarios failed before
the production changes and passed afterward. These are deterministic local failures,
not an estimate of production incidence.

| Evidence on main | Change | Measured result |
| --- | --- | --- |
| Seven malformed argument forms (broken JSON, null, array, string, number, boolean, empty string) reached a tool; the interrupted-batch recovery path also ran broken JSON as `{}`. | Require a JSON object before invocation; return an error paired with the call ID for correction, in ordinary and resumed turns. | Zero malformed calls execute; corrected calls succeed. Repeated malformed calls retain the existing three-call loop stop. |
| All six calls in a read/read/open/fill/read/read batch started together; two actions started even when the first cancelled the run. | Use existing `acts` metadata to finish preceding reads, execute an action alone, then start subsequent calls. Check cancellation before execution. | Open finishes before fill; later reads follow fill. Independent read concurrency remains two. Cancellation starts one action rather than two. |
| Repeating a non-oldest note at the 50-note agent limit deleted the oldest note (49 remained). Repeating the oldest lost its ID, pin and usage. A duplicate failed at both the 50 person-written agent-note limit and the 500 personal-note limit. | Resolve duplicates after checking/locking the agent owner but before eviction or capacity refusal. | All note IDs survive; pin/usage survive; confirming a personal suggestion succeeds at capacity. New-note limits and existing eviction behavior still pass. |

Tests: `test/runtime-loop.test.js` exercises actual loop calls with a scripted model,
the real browser tool's `acts` metadata, and a fake executor; `test/memory-capacity.test.js`
uses the real memory module and PGlite store. No external model, browser or production
database is required.

## Research and reuse

The research ran OpenVibe Search, GitHub repository/code searches (including repositories
created in the last 60 days), Hacker News, the harness web search, and GitHub releases.
DeepSeek Search returned HTTP 402, so its results were unavailable. Six questions covered
personal AI agent memory tools, agent loop tool calling, computer use agents, sequential
side effects, malformed tool arguments, and memory deduplication/capacity. The full dated
research log is in `~/openvibe/research/improve/2026-11-23-actor.md` on the job host.

Three projects were shallow-cloned and read. Counts are the research snapshot, not claims
about their future status:

- **[Pydantic AI](https://github.com/pydantic/pydantic-ai)** — MIT; 21,355 stars;
  pushed 2026-11-23; release [v2.71.0](https://github.com/pydantic/pydantic-ai/releases/tag/v2.71.0).
  At commit `d725f563f563145d6ee6080a987036b38acdedce`,
  [`_tool_execution.py`](https://github.com/pydantic/pydantic-ai/blob/d725f563f563145d6ee6080a987036b38acdedce/pydantic_ai_slim/pydantic_ai/_tool_execution.py)
  segments parallel tools around sequential tools;
  [`tool_manager.py`](https://github.com/pydantic/pydantic-ai/blob/d725f563f563145d6ee6080a987036b38acdedce/pydantic_ai_slim/pydantic_ai/tool_manager.py)
  validates arguments before invocation. Read `tests/test_agent.py`'s sequential-barrier
  scenario and `tests/test_toolsets.py`/`tests/test_tools.py`. Both ideas fit Actor's existing loop.
- **[Agent S](https://github.com/simular-ai/Agent-S)** — Apache-2.0; 13,028 stars;
  pushed 2026-11-23; latest listed release [v0.3.2](https://github.com/simular-ai/Agent-S/releases/tag/v0.3.2).
  At commit `bcdf1d6c8f1cbe3f1c4004e83fad6020651db925`,
  [`gui_agents/s3/cli_app.py`](https://github.com/simular-ai/Agent-S/blob/bcdf1d6c8f1cbe3f1c4004e83fad6020651db925/gui_agents/s3/cli_app.py)
  completes an action before the next observation. Read the agent wrapper and provider tests
  too. This supports ordered computer actions; its sleeps, Python execution and UI code were not reused.
- **[Mem0](https://github.com/mem0ai/mem0)** — Apache-2.0; 69,386 stars;
  pushed 2026-11-23; release [v2.2.1](https://github.com/mem0ai/mem0/releases/tag/v2.2.1).
  At commit `f93aba4b53241ccd9db32903cd19d1ff7f0066f0`,
  [`mem0/memory/main.py`](https://github.com/mem0ai/mem0/blob/f93aba4b53241ccd9db32903cd19d1ff7f0066f0/mem0/memory/main.py)
  checks existing/batch duplicates before preparing inserts. Read `tests/test_memory.py`,
  including avoiding duplicate embedding work. Actor reorders its existing exact-match lookup.

Only design ideas were reused. The JavaScript changes and tests are original to Actor;
no third-party source was copied, and no dependency or schema was added.

## Scope and limits

The portal had 1,462 runs, including 60 with Actor in the job name (45 done, 10 failed,
3 stopped, 1 budget-stopped, 1 running). Those are harness jobs, not Actor product runs.
The seven-day stats showed one failed Muse job; the Actor-related credit incident was
already fixed. No open Actor issue or earlier Actor improvement round supplied a new
product failure. The one open PR (#662) covered rich answers, outside this change.

Action-heavy batches now take the sum of action durations. This trades unsafe overlap
for ordering; reads between actions keep parallel execution. Checkpoints remain per batch
and conservatively ask about pending actions after interruption. Full JSON-schema
validation, memory ranking, canonical loop keys, and context/image budgets remain separate work.

Validation: the two regression files passed; `ov test` passed all 13 remaining selected
files (two already-green files skipped); explicit durable-acting, durable-runs and tool-acts
checks passed too. The final loop guard was checked with runtime-loop and brain-loop.
The full suite is left to the PR pipeline, as required by the repository's test workflow.
