'use strict';

/**
 * The check between `running` and `succeeded` (ADR-044 §5): a result is read by another model before the person gets
 * it. Model-agnostic since 2026-11-21 (the owner: "anything that's DeepSeek reliant or reliant on a specific model …
 * should be using OpenVibe.Exchange … everything should be agnostic of model or harness"): with OpenVibe.AI on, the
 * check asks its Decisions API first (one yes-or-no grading question; AI picks the model, across makers), then the
 * router's check tier for a verdict in words; the direct provider checkers below are only the fallback for a server
 * without OpenVibe.AI. In private mode only OpenVibe's own open model may read the task, so it checks its own answer and
 * the explanation says so. A check that cannot run (no checker, a provider error) does not pass the result unchecked:
 * the task fails with actor.check.unavailable.
 *
 * The bar is "does this answer the task, without invented or self-contradicting facts" — not taste. A refusal, an
 * empty answer or one about something else fails.
 */

// codes: the person's own machine wrote it (any of Codes' agents), so either family reads it.
const FAMILY = { 'openvibe-runtime': 'deepseek', 'openai-agent': 'openai', 'open-model': 'local', codes: 'codes' };
// `runtime`: the OpenVibe runtime on the operator's own model (ACTOR_RUNTIME_URL) — another family first, else itself.
const CHECKER_FOR = { deepseek: ['openai', 'deepseek'], openai: ['deepseek', 'openai'], local: ['local'], codes: ['deepseek', 'openai'], runtime: ['openai', 'deepseek', 'runtime'] };

const SYSTEM = `You check an AI agent's answer before a person sees it. Reply with JSON only: {"ok": true|false, "reason": "<one short sentence>"}.
Only your own reply is JSON. The answer is prose meant to be read by a person (often Markdown) and is never expected to be JSON; tool results are JSON because services return JSON.
ok is true when the answer addresses the task and nothing in it is clearly invented, contradictory or unsafe. It does not have to be perfect.
ok is false when the answer is empty, refuses without a good reason, answers a different question, contradicts itself, or states something that is plainly impossible.
The agent may have searched the web or run tools: do not fail an answer only because it states recent facts, versions, prices or dates you cannot verify yourself, especially when it cites a source for them.
The agent may have made the person's own robot act through OpenVibe.Bot: an answer that reports what the robot did, or why it stopped or was refused, addresses the task.
The agent may have used the person's own computer through OpenVibe.Bot (listed or read files, ran a program, wrote a file): an answer that reports what it found, what a program printed, or why the computer refused, addresses the task.
When the tool results the agent received are given, they are real. Compare every fact in the answer that a tool result covers (a file's contents, a program's output, names, counts, numbers): if any of them differs from the tool result, ok is false and the reason names it. Otherwise do not fail the answer for acting on the person's systems: the tool results show it did.
The agent may have run a coding task on the person's own machine through OpenVibe.Codes: an answer that reports what changed (a summary, the files, a patch), or that the machine is still working on it with a link to follow it, addresses the task.
When the task is a greeting, small talk, a test message or too vague to act on, a short friendly reply, a summary of what the agent can do or a clarifying question is a good answer: ok is true.`;

/**
 * Which checkers may read this agent's answer, best first: another family, then the same family. An answer backed by
 * tool results is checked by comparing the two, which OpenAI's smallest model did not do (it passed an answer that
 * misquoted a file it had been shown, 2026-10-14): for those, OpenAI's stronger checker (`openaiGrounded`, gpt-5-mini by
 * default) reads it when one is configured, so the check stays cross-family.
 */
function checkersFor(agentId, checkers, { mode, grounded = false }) {
    const family = agentId === 'openvibe-runtime' && checkers.runtime ? 'runtime' : FAMILY[agentId];
    const order = mode === 'private' ? ['local'] : (CHECKER_FOR[family] || []);
    const pick = (f) => (grounded && f === 'openai' && checkers.openaiGrounded ? checkers.openaiGrounded : checkers[f]);
    return order.filter((f) => pick(f)).map((f) => ({ family: f, chat: pick(f), cross: f !== family }));
}
const checkerFor = (agentId, checkers, opts) => checkersFor(agentId, checkers, opts)[0] || null;

/**
 * Ask each checker in turn until one gives a verdict: a checker that answers nothing usable (a provider error, no JSON)
 * passes the turn to the next; only when none gives a verdict is the result unavailable (and never delivered).
 */
/** The maker of a model id ("openai/gpt-5.1", "deepseek-flash", "claude-haiku-4-5") in lower case, or '' when unsure. */
function makerOf(model) {
    const id = String(model || '').toLowerCase();
    if (!id) return '';
    if (id.includes('/')) return id.split('/')[0];
    const m = /^(gpt|o[1-9]|chatgpt)\b|^(claude)|^(gemini|gemma)|^(deepseek)|^(qwen)|^(llama)|^(mistral|mixtral|codestral)|^(grok)|^(kimi)|^(glm)/.exec(id);
    if (!m) return '';
    return ['openai', 'anthropic', 'google', 'deepseek', 'qwen', 'meta', 'mistral', 'xai', 'moonshot', 'zhipu'][m.slice(1).findIndex(Boolean)] || '';
}

const DECIDE_QUESTION = 'Does the agent\'s answer address the task, with nothing in it clearly invented, contradictory or unsafe? A short friendly reply to small talk or a vague task is a good answer. When tool results are given they are real: an answer whose facts differ from them is not good. Recent facts, prices and dates the answer cites a source for are not a reason to say no.';

async function check({ task, answer, sources = [], evidence = [], agentId, mode, checkers, signal, now = Date.now, decide = null, routed = null, wroteWith = null }) {
    // The checker knows today's date: without it, a model whose training ends earlier refused a correct web answer for a
    // release "dated Oct 21, 2026, which is in the future and plainly impossible" (2026-10-24, a task from Chat's Vibe).
    const today = new Date(now()).toISOString().slice(0, 10);
    // OpenVibe.AI first (model-agnostic): its check tier gives the verdict in words; the direct checkers follow only as a
    // fallback. Private mode never leaves OpenVibe, so it keeps its own model.
    const viaAi = mode !== 'private' && routed && typeof routed.chat === 'function'
        ? [{ family: 'openvibe-ai', chat: (args) => routed.chat({ tier: 'check', ...args }), viaAi: true }] : [];
    const list = [...viaAi, ...checkersFor(agentId, checkers, { mode, grounded: evidence.length > 0 })];
    if (!list.length) return { ok: false, unavailable: true, reason: 'no model is available to check this answer', cost_usd: 0 };
    let cost = 0;
    let last = 'no checker gave a verdict';
    const cited = sources.length ? `\n\nSources the agent cites:\n${sources.slice(0, 10).join('\n')}` : '';
    // What the agent's tools answered (the runtime's own calls, never the model's words): the check reads the answer
    // against them instead of guessing whether a reported fact was invented. At most 6000 characters in all.
    let room = 6000;
    const seen = [];
    for (const e of evidence) {
        if (room <= 0) break;
        const line = `${e.tool}: ${String(e.result || '').slice(0, Math.min(1500, room))}`;
        room -= line.length;
        seen.push(line);
    }
    const tools = seen.length ? `\n\n=== Tool results the agent received (real, returned by OpenVibe services) ===\n${seen.join('\n')}\n=== End of tool results ===` : '';
    const writer = makerOf(wroteWith);
    // The Decisions API: one calibrated yes-or-no, the cheapest check there is. A clear yes delivers the answer; a no or
    // an unsure one goes on to a model that says why in words (a person is never told "no" without a reason).
    if (decide && mode !== 'private') {
        try {
            const d = await decide({
                input: `=== Task ===\n${String(task).slice(0, 6000)}\n\n=== The agent's answer ===\n${String(answer).slice(0, 12000)}\n=== End of answer ===${cited}${tools}\n\nToday is ${today} (UTC).`,
                model: 'auto', kind: 'grading', questions: { good: { type: 'noul', instructions: DECIDE_QUESTION } },
            }, { signal });
            cost += Number(d && d.receipt && d.receipt.cost_usd) || 0;
            const a = d && d.answers && d.answers.good;
            const p = a ? Number(a.noul) : NaN;
            const by = d && d.receipt ? String(d.receipt.model || d.receipt.provider || 'OpenVibe.AI') : 'OpenVibe.AI';
            if (Number.isFinite(p) && p >= 0.6) {
                return { ok: true, reason: `${Math.round(p * 100)}% sure it answers the task`, cost_usd: cost, by, model: by, cross: !writer || makerOf(by) !== writer };
            }
        } catch (err) {
            if (signal && signal.aborted) throw err;
        }
    }
    for (const c of list) {
        try {
            const r = await c.chat({
                messages: [{ role: 'system', content: `${SYSTEM}\nToday is ${today} (UTC). A date on or before today is in the past or present, never in the future; recent releases, prices and events up to today are possible.` }, { role: 'user', content: `=== Task ===\n${String(task).slice(0, 6000)}\n\n=== The agent's answer (prose to the person) ===\n${String(answer).slice(0, 12000)}\n=== End of answer ===${cited}${tools}` }],
                // 600, not 160: a reasoning model spent 160 on thinking and answered nothing, and the answer was withheld.
                json: true, maxTokens: 600, signal,
            });
            cost += r.cost_usd || 0;
            let parsed = null;
            const m = String(r.text || '').match(/\{[\s\S]*\}/);
            try { parsed = m ? JSON.parse(m[0]) : null; } catch { parsed = null; }
            if (!parsed || typeof parsed.ok !== 'boolean') { last = `${c.family} gave no verdict`; continue; }
            if (c.viaAi) return { ok: parsed.ok, reason: String(parsed.reason || '').slice(0, 300), cost_usd: cost, by: String(r.model || 'OpenVibe.AI'), model: r.model, cross: !writer || makerOf(r.model) !== writer };
            return { ok: parsed.ok, reason: String(parsed.reason || '').slice(0, 300), cost_usd: cost, by: c.family, model: r.model, cross: c.cross };
        } catch (err) {
            if (signal && signal.aborted) throw err;
            last = `${c.family} could not check (${(err && err.message) || err})`.slice(0, 300);
        }
    }
    return { ok: false, unavailable: true, reason: last, cost_usd: cost };
}

module.exports = { check, checkerFor, checkersFor, FAMILY, makerOf };
