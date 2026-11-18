'use strict';

/**
 * decide: OpenVibe.AI's Decisions API as a tool of the loop (plan §AD.27 item 6, "Decisions where they help"; the owner,
 * 11-18: "use decisions and like other smart shit"). The agent gathers the facts, then settles a judgement with
 * calibrated odds: a yes-or-no question, one of 2 to 12 options, or a rating on 3 to 6 levels. Never for a fact it can
 * look up: the answer is a judgement over what it is given, not a source.
 *
 *   input { question, kind: yes_no | pick | rate, options?, facts? }
 */
const MAX_OPTIONS = { pick: [2, 12], rate: [3, 6] };

module.exports = {
    name: 'decide',
    description: 'Settle a judgement with calibrated odds after you have the facts: a yes-or-no question (kind yes_no), which of 2 to 12 options fits best (kind pick), or a rating on 3 to 6 levels (kind rate, options from lowest to highest). '
        + 'Put what you found in facts. It returns each answer\'s probability. Use it to choose between offers, rank options or check a claim against the facts; never for facts you can look up.',
    input: {
        type: 'object',
        properties: {
            question: { type: 'string', description: 'The judgement, as one question.' },
            kind: { type: 'string', enum: ['yes_no', 'pick', 'rate'] },
            options: { type: 'array', items: { type: 'string' }, description: 'For pick: the choices. For rate: the levels, lowest first.' },
            facts: { type: 'string', description: 'What you found, for the judgement to rest on.' },
        },
        required: ['question', 'kind'],
    },
    scope: 'public',
    needs: { files: 'none', network: false },
    connector: 'openvibe',
    costUsd: 0.002,
    timeoutMs: 40_000,
    available: (ctx) => Boolean(ctx.models && typeof ctx.models.decide === 'function'),
    async run(input, ctx) {
        const question = String((input && input.question) || '').trim().slice(0, 500);
        const kind = String((input && input.kind) || '');
        if (!question) return { error: 'Ask one question ({ question, kind }).' };
        if (!['yes_no', 'pick', 'rate'].includes(kind)) return { error: 'kind is yes_no, pick or rate.' };
        const options = [...new Set((Array.isArray(input.options) ? input.options : []).map((o) => String(o || '').trim().slice(0, 120)).filter(Boolean))];
        if (MAX_OPTIONS[kind] && (options.length < MAX_OPTIONS[kind][0] || options.length > MAX_OPTIONS[kind][1])) {
            return { error: `${kind === 'pick' ? 'A pick' : 'A rating'} needs ${MAX_OPTIONS[kind][0]} to ${MAX_OPTIONS[kind][1]} options.` };
        }
        const spec = kind === 'yes_no' ? { type: 'noul', instructions: question }
            : kind === 'pick' ? { type: 'choice', instructions: question, criteria: Object.fromEntries(options.map((o) => [o, o])) }
                : { type: 'score', instructions: question, criteria: options };
        const facts = String((input && input.facts) || '').trim().slice(0, 12000);
        let d;
        try {
            d = await ctx.models.decide({ input: facts ? `${question}\n\nFacts:\n${facts}` : question, questions: { q: spec }, model: 'auto', kind: 'other' }, { signal: ctx.signal });
        } catch (err) { return { error: `The Decisions API did not answer: ${(err && err.message) || 'unavailable'}` }; }
        if (ctx.meter && d && d.receipt) { try { await ctx.meter(Number(d.receipt.cost_usd) || 0); } catch { /* the loop meters too */ } }
        const a = d && d.answers && d.answers.q;
        if (!a) return { error: 'The Decisions API gave no answer.' };
        const pct = (p) => `${Math.round(Number(p) * 100)}%`;
        let text;
        if (a.type === 'noul') text = `${a.noul >= 0.5 ? 'Yes' : 'No'}, ${pct(a.noul >= 0.5 ? a.noul : 1 - a.noul)} sure: ${question}`;
        else if (a.type === 'choice') {
            const ranked = Object.entries(a.probabilities || {}).sort((x, y) => y[1] - x[1]);
            text = `${a.choice} (${pct((a.probabilities || {})[a.choice] || 0)}): ${question}\n${ranked.map(([k, p]) => `- ${k}: ${pct(p)}`).join('\n')}`;
        } else {
            const legend = a.legend || {};
            const level = Math.round(Number(a.score) || 0);
            text = `${legend[String(level)] || options[level] || level} (${Number(a.score).toFixed(2)} on 0 to ${options.length - 1}): ${question}`;
        }
        return { text: `${text}\n(${d.calibrated ? 'calibrated' : 'estimated'} odds, a judgement over the facts given, not a source)`, data: { type: a.type, answer: a, calibrated: Boolean(d.calibrated) } };
    },
};
