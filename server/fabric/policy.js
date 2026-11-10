'use strict';
const { createHash } = require('node:crypto');
const assert = (ok, message) => { if (!ok) throw Object.assign(new Error(message), { status: 422 }); };
const text = (s) => typeof s === 'string' && s.trim().length > 0;
function policy(input = {}) {
    const p = structuredClone({ mode: 'observe', rules: [], sources: {}, budget: { usd: 0, tokens: 0, wall_minutes: 0 }, ...input });
    delete p.version;
    assert(['off', 'observe', 'auto'].includes(p.mode), 'Invalid accept mode');
    assert(Array.isArray(p.rules) && p.rules.every(r => text(r.id) && text(r.instruction) && typeof r.enabled === 'boolean' && (r.mode == null || ['observe', 'auto'].includes(r.mode))) && new Set(p.rules.map(r => r.id)).size === p.rules.length, 'Rules need unique ids, instructions, enabled flags and an observe or auto mode');
    assert(p.budget && ['usd', 'tokens', 'wall_minutes'].every(k => Number.isFinite(p.budget[k]) && p.budget[k] >= 0) && Number.isInteger(p.budget.tokens), 'Invalid mandate budget');
    assert(p.sources && typeof p.sources === 'object' && !Array.isArray(p.sources), 'Invalid source policies');
    for (const s of Object.values(p.sources)) {
        assert(Array.isArray(s.allowed) && Array.isArray(s.bots) && [...s.allowed, ...s.bots].every(text), 'Source identities must be lists');
        for (const row of Object.values(s.admission || {})) {
            assert(['inferred', 'ignore'].includes(row.listed_unaddressed || 'inferred'), 'Invalid listed admission');
            assert(['explicit', 'inferred', 'ignore'].includes(row.unlisted_addressed || 'ignore'), 'Invalid addressed admission');
            assert(['inferred', 'ignore'].includes(row.unlisted_unaddressed || 'ignore'), 'Invalid unaddressed admission');
        }
    }
    // Version covers every nested policy value, including budget; object insertion order is normalized recursively.
    const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
    p.version = createHash('sha256').update(JSON.stringify(stable(p))).digest('hex');
    return p;
}
function gate(t, p, source, followup = false) {
    const s = p.sources[t.source];
    if (!s || !source || source.enabled === false || !source.scopes.includes(t.source_scope)) return null;
    const addressed = ['mention', 'direct'].includes(t.addresses_agent);
    const all = (source.receive_all || []).includes(t.source_scope);
    const listed = s.allowed.includes(t.actor.id);
    const bot = t.actor.kind !== 'person' || s.bots.includes(t.actor.id);
    let strength, basis;
    if (bot) {
        if (!s.bots.includes(t.actor.id) || !(addressed || all)) return null;
        strength = 'inferred'; basis = 'bot';
    } else if (listed && addressed) { strength = 'explicit'; basis = 'addressed'; }
    else {
        const row = (s.admission || {})[t.source_scope] || {};
        const cell = listed ? 'listed_unaddressed' : addressed ? 'unlisted_addressed' : 'unlisted_unaddressed';
        const admission = (addressed || all) ? row[cell] || (listed ? 'inferred' : 'ignore') : 'ignore';
        if (admission === 'explicit') { strength = 'explicit'; basis = 'table'; }
        else if (followup) { strength = listed ? 'explicit' : 'inferred'; basis = 'followup'; }
        else if (admission === 'inferred') { strength = 'inferred'; basis = 'table'; }
        else return null;
    }
    return strength === 'inferred' && p.mode === 'off' ? null : { strength, basis };
}
function revalidate(ticket, meta, original, p, sources) {
    const m = ticket.mandate, source = sources[original.source];
    if (!source || source.enabled === false || !source.scopes.includes(original.source_scope)) return false;
    if (m.strength === 'inferred' && (p.mode !== 'auto' || m.matched_rules.some(id => !p.rules.some(r => r.id === id && r.enabled)))) return false;
    if (meta.basis === 'followup' && m.strength === 'explicit') return true;
    if (meta.basis === 'addressed' && !p.sources[original.source]?.allowed.includes(m.actor.id)) return false;
    const g = gate(original, p, source, meta.basis === 'followup');
    return !!g && (g.strength === 'explicit' || m.strength === 'inferred');
}
function assessment(a, p, triggers) {
    const rules = p.rules.filter(r => r.enabled), judged = a.rule_assessments;
    assert(Array.isArray(judged) && judged.length === rules.length && new Set(judged.map(r => r.rule_id)).size === rules.length && rules.every(r => judged.some(j => j.rule_id === r.id)), 'Exactly one assessment per enabled rule');
    assert(judged.every(r => typeof r.matched === 'boolean' && text(r.reason)), 'Invalid rule assessment');
    const d = a.direction;
    assert(d && typeof d.implementation_requested === 'boolean' && typeof d.requires_design_decision === 'boolean' && ['specified', 'existing-standard', 'undetermined'].includes(d.target_basis) && Array.isArray(d.evidence), 'Invalid structured direction');
    assert(d.evidence.every(e => text(e.quote) && triggers.some(t => t.id === e.trigger_id && t.text.includes(e.quote))), 'Evidence must quote a trigger verbatim');
    assert(['accept', 'ignore', 'unavailable'].includes(a.decision), 'Invalid assessment decision');
    const matched = judged.filter(r => r.matched).map(r => r.rule_id);
    const accepted = a.decision === 'accept' && d.implementation_requested && d.target_basis !== 'undetermined' && !d.requires_design_decision && d.evidence.length > 0 && matched.length > 0;
    if (accepted) assert(text(a.scope), 'Acceptance needs a scope');
    return { matched, accepted };
}
// A lane without an explicit mode is in observe: lanes never inherit autonomy from a global switch by accident.
const laneMode = (rule) => (rule && rule.mode === 'auto' ? 'auto' : 'observe');
module.exports = { policy, gate, revalidate, assessment, assert, text, laneMode };
