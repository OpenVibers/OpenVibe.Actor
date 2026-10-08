'use strict';

/**
 * Which agent system takes a task: openvibe-sdk/placement over the catalog's offers (ADR-044 §§3–4). Hard requirements
 * first — the task class's capability, the trust private mode demands, the budget as a cost ceiling, the agent's
 * health — then the mode's objective:
 *
 *   cheapest → cheapest · balanced → balanced · fastest → lowest-latency · private → private (first-party only)
 *   best     → balanced among agents that offer quality:high; when none can take the task, balanced among the rest,
 *              and the explanation says so (ADR-044 leaves what `best` maps to open; this is the first answer)
 *
 * A hand-off (escalate: the agent before it failed, or its answer failed the check) never goes to a weaker agent: it
 * requires the quality tier of the agent that failed (quality:standard after the runtime), so a task is never handed
 * from a capable model to a smaller one. Private mode has only the open model, so it never escalates.
 *
 * The answer is a platform.placement-result@1, stored on the task as its explanation. An agent that is down carries
 * the catalog's reason instead of the planner's "health down"; agents already tried on this task are listed with why.
 */
const contracts = require('openvibe-contracts');
const { plan } = require('openvibe-sdk/placement');
const catalog = require('./catalog');
const { requirementFor } = require('./classify');

const OBJECTIVE = { cheapest: 'cheapest', balanced: 'balanced', fastest: 'lowest-latency', private: 'private', best: 'balanced' };
const MODES = Object.keys(OBJECTIVE);

function planOnce({ cls, mode, pinned, budgetUsd, config, tried, now, measured, quality, floor = null }) {
    const req = {
        kind: `actor.${cls}`,
        mobility: 'job',
        latency_class: 'interactive',
        objective: OBJECTIVE[mode],
        capabilities: [requirementFor(cls), ...(quality ? ['quality:high'] : floor ? [`quality:${floor}`] : [])],
    };
    if (mode === 'private') req.trust = ['first-party'];
    if (budgetUsd != null) req.max_cost_usd = budgetUsd;
    const agents = catalog.AGENTS.filter((a) => !tried.has(a.id) && (!pinned || a.id === pinned));
    const offers = agents.map((a) => catalog.toOffer(a, config, { now, measured }));
    const r = plan(req, offers, { now });
    for (const c of r.candidates) {
        if (!c.eligible && /^health /.test(c.excluded_because || '')) {
            const av = catalog.availability(catalog.byId(c.id), config);
            c.excluded_because = av.reason || c.excluded_because;
        }
        if (!c.eligible) for (const k of ['estimated_cost_usd', 'estimated_latency_ms']) if (c[k] == null || !Number.isFinite(c[k])) delete c[k];
    }
    return r;
}

/**
 * route({ cls, mode, agent, budgetUsd, config, tried: Map<id, why>, now, measured }) → platform.placement-result@1
 * (selected is null when nothing can take the task; the reasons say why).
 */
function route({ cls, mode = 'balanced', agent = null, budgetUsd = null, config, tried = new Map(), now = Date.now(), measured = {}, floor = null }) {
    const triedIds = new Set(tried.keys());
    let r = planOnce({ cls, mode, pinned: agent, budgetUsd, config, tried: triedIds, now, measured, quality: mode === 'best', floor });
    if (mode === 'best' && !r.selected) {
        const fallback = planOnce({ cls, mode, pinned: agent, budgetUsd, config, tried: triedIds, now, measured, quality: false, floor });
        if (fallback.selected) r = { ...fallback, reasons: ['best mode: no high-quality agent can take this task, so the best of the rest', ...(fallback.reasons || [])] };
    }
    for (const [id, why] of tried) r.candidates.push({ id, eligible: false, excluded_because: `tried first: ${why}`.slice(0, 200) });
    if (agent && !catalog.byId(agent)) r.reasons = [`no agent "${agent}" in the catalog`];
    r.reasons = (r.reasons || []).map((x) => String(x).slice(0, 300));
    const result = JSON.parse(JSON.stringify(r));
    if (result.selected) {
        const v = contracts.validate('platform.placement-result@1', result);
        if (!v.valid) throw Object.assign(new Error(`invalid placement result: ${JSON.stringify(v.errors).slice(0, 300)}`), { code: 'actor.placement_invalid' });
    }
    return result;
}

/** Why nothing was selected, for the task's error: the budget, private mode, or no agent with the capability. */
function whyNone(result, { cls, mode, budgetUsd }) {
    const cands = result.candidates || [];
    if (cands.some((c) => /over \$/.test(c.excluded_because || ''))) {
        const cheapest = Math.min(...catalog.AGENTS.filter((a) => a.can.includes(requirementFor(cls))).map((a) => catalog.typicalCost(a.id)));
        return { code: 'actor.budget.exceeded', detail: `The cheapest agent that can take this task would cost about $${cheapest.toFixed(3)}, over this task's $${Number(budgetUsd).toFixed(3)} budget. Raise the budget or ask something simpler.` };
    }
    if (mode === 'private') return { code: 'actor.no_agent', detail: `Private mode keeps the task on OpenVibe's own hardware, and no agent there can take a "${cls}" task yet (the open model answers simple questions only).` };
    if (cls === 'code') return { code: 'actor.no_agent', detail: 'Coding tasks go to OpenVibe.Codes, and hosted coding runs are not open yet. Run openvibe-codes on your own machine: https://openvibe.codes/start' };
    const down = cands.filter((c) => !c.eligible).map((c) => `${c.id}: ${c.excluded_because}`).join('; ');
    return { code: 'actor.no_agent', detail: `No agent can take this task right now (${down || 'none configured'}).`.slice(0, 2000) };
}

module.exports = { route, whyNone, OBJECTIVE, MODES };
