'use strict';

/**
 * The check between `running` and `succeeded` (ADR-044 §5): a result is read by a model of another family than the
 * one that wrote it before the person gets it. DeepSeek's answers are checked by OpenAI's smallest model and OpenAI's
 * by DeepSeek; in private mode only OpenVibe's own open model may read the task, so it checks its own answer and the
 * explanation says so. A check that cannot run (no checker, a provider error) does not pass the result unchecked:
 * the task fails with actor.check.unavailable.
 *
 * The bar is "does this answer the task, without invented or self-contradicting facts" — not taste. A refusal, an
 * empty answer or one about something else fails.
 */

const FAMILY = { 'openvibe-runtime': 'deepseek', 'openai-agent': 'openai', 'open-model': 'local' };
const CHECKER_FOR = { deepseek: ['openai', 'deepseek'], openai: ['deepseek', 'openai'], local: ['local'] };

const SYSTEM = `You check an AI agent's answer before a person sees it. Reply with JSON only: {"ok": true|false, "reason": "<one short sentence>"}.
ok is true when the answer addresses the task and nothing in it is clearly invented, contradictory or unsafe. It does not have to be perfect.
ok is false when the answer is empty, refuses without a good reason, answers a different question, or states something clearly false.`;

/** Which checker reads this agent's answer, and whether it is of another family. */
function checkerFor(agentId, checkers, { mode }) {
    const family = FAMILY[agentId];
    const order = mode === 'private' ? ['local'] : (CHECKER_FOR[family] || []);
    for (const f of order) if (checkers[f]) return { family: f, chat: checkers[f], cross: f !== family };
    return null;
}

async function check({ task, answer, agentId, mode, checkers, signal }) {
    const c = checkerFor(agentId, checkers, { mode });
    if (!c) return { ok: false, unavailable: true, reason: 'no model is available to check this answer', cost_usd: 0 };
    try {
        const r = await c.chat({
            messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Task:\n${String(task).slice(0, 6000)}\n\nAnswer:\n${String(answer).slice(0, 12000)}` }],
            json: true, maxTokens: 120, signal,
        });
        let parsed = null;
        try { parsed = JSON.parse(String(r.text || '').trim().replace(/^```(?:json)?|```$/g, '')); } catch { parsed = null; }
        if (!parsed || typeof parsed.ok !== 'boolean') return { ok: false, unavailable: true, reason: 'the checker gave no verdict', cost_usd: r.cost_usd, by: c.family, cross: c.cross };
        return { ok: parsed.ok, reason: String(parsed.reason || '').slice(0, 300), cost_usd: r.cost_usd, by: c.family, model: r.model, cross: c.cross };
    } catch (err) {
        if (signal && signal.aborted) throw err;
        return { ok: false, unavailable: true, reason: `the check could not run (${(err && err.message) || err})`.slice(0, 300), cost_usd: 0, by: c.family, cross: c.cross };
    }
}

module.exports = { check, checkerFor, FAMILY };
