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
ok is false when the answer is empty, refuses without a good reason, answers a different question, contradicts itself, or states something that is plainly impossible.
The agent may have searched the web or run tools: do not fail an answer only because it states recent facts, versions, prices or dates you cannot verify yourself, especially when it cites a source for them.`;

/** Which checkers may read this agent's answer, best first: another family, then the same family. */
function checkersFor(agentId, checkers, { mode }) {
    const family = FAMILY[agentId];
    const order = mode === 'private' ? ['local'] : (CHECKER_FOR[family] || []);
    return order.filter((f) => checkers[f]).map((f) => ({ family: f, chat: checkers[f], cross: f !== family }));
}
const checkerFor = (agentId, checkers, opts) => checkersFor(agentId, checkers, opts)[0] || null;

/**
 * Ask each checker in turn until one gives a verdict: a checker that answers nothing usable (a provider error, no JSON)
 * passes the turn to the next; only when none gives a verdict is the result unavailable (and never delivered).
 */
async function check({ task, answer, sources = [], agentId, mode, checkers, signal }) {
    const list = checkersFor(agentId, checkers, { mode });
    if (!list.length) return { ok: false, unavailable: true, reason: 'no model is available to check this answer', cost_usd: 0 };
    let cost = 0;
    let last = 'no checker gave a verdict';
    const cited = sources.length ? `\n\nSources the agent cites:\n${sources.slice(0, 10).join('\n')}` : '';
    for (const c of list) {
        try {
            const r = await c.chat({
                messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Task:\n${String(task).slice(0, 6000)}\n\nAnswer:\n${String(answer).slice(0, 12000)}${cited}` }],
                json: true, maxTokens: 160, signal,
            });
            cost += r.cost_usd || 0;
            let parsed = null;
            const m = String(r.text || '').match(/\{[\s\S]*\}/);
            try { parsed = m ? JSON.parse(m[0]) : null; } catch { parsed = null; }
            if (!parsed || typeof parsed.ok !== 'boolean') { last = `${c.family} gave no verdict`; continue; }
            return { ok: parsed.ok, reason: String(parsed.reason || '').slice(0, 300), cost_usd: cost, by: c.family, model: r.model, cross: c.cross };
        } catch (err) {
            if (signal && signal.aborted) throw err;
            last = `${c.family} could not check (${(err && err.message) || err})`.slice(0, 300);
        }
    }
    return { ok: false, unavailable: true, reason: last, cost_usd: cost };
}

module.exports = { check, checkerFor, checkersFor, FAMILY };
