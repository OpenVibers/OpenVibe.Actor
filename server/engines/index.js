'use strict';

/**
 * Engines: the ways one task can be worked (the owner, 2026-11-16: "Actor should allow a mix or modular system where you
 * can use an agent or harness or model system or a decisions API or swap between and benchmark the different ways our
 * shit works"). A task names its engine (`engine` on POST /api/v1/tasks); without one, Actor chooses as before.
 *
 *   agent        Actor's own agent loop: a plan, OpenVibe's tools, a check (the default); `model` picks its model
 *   model        one model, one answer, no tools: any model on OpenVibe.Exchange through OpenVibe.AI (`model`, else auto)
 *   decisions    OpenVibe.AI's Decisions API: the task as a yes-or-no, pick-one or rate-it question, answered with
 *                probabilities in one pass (`model`: a decisions model, else auto). A task that is not such a question
 *                is refused in words, never forced into one
 *   harness      a coding harness through OpenVibe.Codes on the person's own machine (`harness`: claude-code, codex,
 *                opencode, gemini, muse …; absent, Codes chooses)
 *   openai-agent OpenAI's agent with its hosted web search
 *   open-model   the small open model on OpenVibe's own server: nothing leaves OpenVibe
 *
 * Each engine is one module with one shape, so a new way to work a task is one more entry.
 */

const KINDS = ['agent', 'model', 'decisions', 'harness', 'openai-agent', 'open-model'];
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const HARNESS_ID = /^[a-z][a-z0-9-]{0,39}$/;

const ENGINES = [
    { kind: 'agent', name: 'Actor\'s agent', blurb: 'Plans, uses OpenVibe\'s tools (search, Tools, your computers and robots), checks its answer. Pick its model, or a specialist (Design).', options: ['model', 'specialist'] },
    { kind: 'model', name: 'One model', blurb: 'Any model on OpenVibe.Exchange answers in one call, with no tools: the quickest and cheapest way, and the way to compare models.', options: ['model'] },
    { kind: 'decisions', name: 'Decisions', blurb: 'OpenVibe.AI\'s Decisions API: a yes-or-no, pick-one or rate-it question answered with probabilities in one pass. For choosing, routing and grading.', options: ['model'] },
    { kind: 'harness', name: 'A coding harness', blurb: 'Claude Code, Codex, OpenCode, Gemini, Muse or CodeBuddy (WorkBuddy\'s agent, on Tencent\'s Hy4) through OpenVibe.Codes, on your own machine.', options: ['harness'] },
    { kind: 'openai-agent', name: 'OpenAI agent', blurb: 'OpenAI\'s agent with its own live web search.', options: [] },
    { kind: 'open-model', name: 'Open model on OpenVibe', blurb: 'A small open model on OpenVibe\'s own server: nothing leaves OpenVibe.', options: [] },
];
// codebuddy-code (2026-11-17): WorkBuddy's agent, run by Codes over ACP on the person's own WorkBuddy login (Hy4 flash is
// free there to 30 November 2026).
// The agent engine's specialists (plan §AD.25, server/specialists): a craft's brief and tools on Actor's own loop.
const { SPECIALISTS } = require('../specialists/names');
const HARNESSES = ['claude-code', 'codex', 'opencode', 'gemini', 'muse', 'codebuddy-code', 'qwen', 'goose', 'aider'];

/**
 * A task's engine from a request: null (Actor chooses) or { kind, model?, harness? }, or { error } in words.
 */
function parseEngine(value) {
    if (value == null || value === '' || value === 'auto') return { engine: null };
    const v = typeof value === 'string' ? { kind: value } : value;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'engine: { kind, model?, harness? }, or a kind\'s name' };
    if (!KINDS.includes(v.kind)) return { error: `engine.kind: one of ${KINDS.join(', ')}` };
    const out = { kind: v.kind };
    if (v.model != null && v.model !== '' && v.model !== 'auto') {
        if (!['agent', 'model', 'decisions'].includes(v.kind)) return { error: `engine.model: only the agent, model and decisions engines take a model` };
        if (typeof v.model !== 'string' || !MODEL_ID.test(v.model)) return { error: 'engine.model: an exact model id, like openai/gpt-5.2 or deepseek/deepseek-flash' };
        out.model = v.model;
    }
    if (v.harness != null && v.harness !== '') {
        if (v.kind !== 'harness') return { error: 'engine.harness: only the harness engine takes a harness' };
        if (typeof v.harness !== 'string' || !HARNESS_ID.test(v.harness)) return { error: 'engine.harness: a harness id, like claude-code, codex or opencode' };
        out.harness = v.harness;
    }
    if (v.specialist != null && v.specialist !== '') {
        if (v.kind !== 'agent') return { error: 'engine.specialist: only the agent engine takes a specialist' };
        if (!SPECIALISTS.includes(v.specialist)) return { error: `engine.specialist: one of ${SPECIALISTS.join(', ')}` };
        out.specialist = v.specialist;
    }
    // Code mode (plan §AD.26): the agent engine's read-only tools behind tools_search and tools_code.
    if (v.code != null) {
        if (v.kind !== 'agent') return { error: 'engine.code: only the agent engine works in code mode' };
        if (typeof v.code !== 'boolean') return { error: 'engine.code: true or false' };
        out.code = v.code;
    }
    for (const k of Object.keys(v)) if (!['kind', 'model', 'harness', 'specialist', 'code'].includes(k)) return { error: `engine.${k} is not an engine option` };
    return { engine: out };
}

/** The engine stored on a task row (jsonb), or null. */
function engineOf(row) {
    const e = row && row.engine;
    if (!e) return null;
    try { return typeof e === 'string' ? JSON.parse(e) : e; } catch { return null; }
}

/** A short name for an engine, as a person reads it on a comparison: "One model · openai/gpt-5.2". */
function label(e) {
    if (!e) return 'Actor chooses';
    const base = (ENGINES.find((x) => x.kind === e.kind) || { name: e.kind }).name;
    if (e.specialist) return `${e.specialist.charAt(0).toUpperCase()}${e.specialist.slice(1)}${e.model ? ` · ${e.model}` : ''}`;
    return e.model ? `${base} · ${e.model}` : e.harness ? `${base} · ${e.harness}` : base;
}
/** A stable key for the leaderboard: kind, then its model or harness. */
const keyOf = (e) => (e ? [e.kind, e.model || e.harness || ''].filter(Boolean).join(':') : 'auto');

const ONE_MODEL_SYSTEM = () => `You are a helpful assistant answering one task in one reply. Today is ${new Date().toISOString().slice(0, 10)}.
Lead with the answer in one or two sentences, the key fact in **bold**; then what helps the person act on it. Use Markdown lists where they help. If you are not sure or cannot know (anything after your training, live prices, the person's own data), say so plainly instead of guessing.`;

const SHAPE_SYSTEM = `Turn a task into ONE closed question for a decisions model, or say it is not one. Reply with JSON only:
{"type":"noul"|"choice"|"score"|"none","question":"<the question, one sentence>","options":["<option>", …],"input":"<the material the question is about, copied from the task, or empty>","why":"<when none: one short sentence>"}
- noul: a yes-or-no question ("Is this email spam?"). options: [].
- choice: pick one of 2 to 12 options named in the task ("Which of these three laptops is best for travel?"). options: the names, as written.
- score: rate something on a scale; options: the levels from worst to best, 3 to 6 of them ("poor", "fair", "good", "excellent").
- none: anything that needs writing, research, steps or open-ended answers.
Never invent options the task does not name, except the levels of a score.`;

/**
 * The engines that run without the agent loop: one model, and the Decisions API.
 *   createEngines({ models, log }) → { model(args), decisions(args) }
 *   args: { task, subject, model, signal, meter, budgetLeft, emit } → { text, sources, model, decision? }
 */
function createEngines({ models, log = console } = {}) {
    const fail = (message, code) => Object.assign(new Error(message), { code });
    const withPerson = (choice, fn) => (models && typeof models.withChoice === 'function' && choice ? models.withChoice(choice, fn) : fn());

    async function model({ task, subject = null, model: id = null, signal, meter, budgetLeft, emit }) {
        if (!models || typeof models.chat !== 'function') throw fail('No model layer is set up on this server.', 'actor.engine.unavailable');
        if (budgetLeft() <= 0) throw fail('The task reached its budget.', 'actor.budget.exceeded');
        // A status line is a plan step: as a text step it stood in for the answer, and the menu never showed the answer.
        await emit({ step: 'plan', text: id ? `Asking ${id}, one call, no tools.` : 'Asking a model, one call, no tools.' });
        const choice = id ? { model: id, ...(subject ? { subject } : {}) } : (subject ? { subject } : null);
        const r = await withPerson(choice, () => models.chat({ tier: 'smart', messages: [{ role: 'system', content: ONE_MODEL_SYSTEM() }, { role: 'user', content: task }], maxTokens: 3000, signal, subject }));
        await meter(Number(r.cost_usd) || 0);
        const text = String(r.text || '').trim();
        if (!text) throw fail('The model gave no answer.', 'actor.agent.no_answer');
        return { text, sources: [], model: r.model || id || null };
    }

    async function decisions({ task, subject = null, model: id = null, signal, meter, budgetLeft, emit }) {
        if (!models || typeof models.decide !== 'function' || typeof models.chat !== 'function') throw fail('The Decisions API is not reachable from this server.', 'actor.engine.unavailable');
        if (budgetLeft() <= 0) throw fail('The task reached its budget.', 'actor.budget.exceeded');
        await emit({ step: 'text', text: 'Reading the task as one closed question…' });
        const shapeRun = () => models.chat({ tier: 'fast', json: true, messages: [{ role: 'system', content: SHAPE_SYSTEM }, { role: 'user', content: task }], maxTokens: 800, signal, subject });
        const shaped = await withPerson(subject ? { subject } : null, shapeRun);
        await meter(Number(shaped.cost_usd) || 0);
        let q;
        try { q = JSON.parse(String(shaped.text || '{}')); } catch { q = { type: 'none' }; }
        const options = Array.isArray(q.options) ? [...new Set(q.options.map((o) => String(o || '').trim().slice(0, 120)).filter(Boolean))] : [];
        if (!['noul', 'choice', 'score'].includes(q.type) || !String(q.question || '').trim()
            || (q.type === 'choice' && (options.length < 2 || options.length > 12)) || (q.type === 'score' && (options.length < 3 || options.length > 6))) {
            throw fail(`This is not a yes-or-no, pick-one or rate-it question${q.why ? ` (${String(q.why).slice(0, 160)})` : ''}, so the Decisions API cannot answer it. Ask Actor's agent or one model instead.`, 'actor.engine.not_suited');
        }
        const question = String(q.question).trim().slice(0, 500);
        const spec = q.type === 'noul' ? { type: 'noul', instructions: question }
            : q.type === 'choice' ? { type: 'choice', instructions: question, criteria: Object.fromEntries(options.map((o) => [o, o])) }
                : { type: 'score', instructions: question, criteria: options };
        await emit({ step: 'tool_call', tool: 'decisions', input: question.slice(0, 300) });
        const d = await models.decide({ input: String(q.input || '').trim() || task, questions: { q: spec }, model: id || 'auto', kind: 'other' }, { signal, subject });
        await meter(Number(d.receipt && d.receipt.cost_usd) || 0);
        const a = d.answers && d.answers.q;
        if (!a) throw fail('The Decisions API gave no answer.', 'actor.agent.no_answer');
        const pct = (p) => `${Math.round(Number(p) * 100)}%`;
        let text;
        if (a.type === 'noul') {
            text = `**${a.noul >= 0.5 ? 'Yes' : 'No'}** (${pct(a.noul >= 0.5 ? a.noul : 1 - a.noul)} sure): ${question}`;
        } else if (a.type === 'choice') {
            const ranked = Object.entries(a.probabilities || {}).sort((x, y) => y[1] - x[1]);
            text = `**${a.choice}** (${pct((a.probabilities || {})[a.choice] || 0)}): ${question}\n\n${ranked.map(([k, p]) => `- ${k}: ${pct(p)}`).join('\n')}`;
        } else {
            const legend = a.legend || {};
            const level = Math.round(Number(a.score) || 0);
            text = `**${legend[String(level)] || level}** (${Number(a.score).toFixed(2)} on 0 to ${options.length - 1}): ${question}\n\n${Object.entries(a.probabilities || {}).map(([k, p]) => `- ${legend[k] || k}: ${pct(p)}`).join('\n')}`;
        }
        const r = d.receipt || {};
        await emit({ step: 'tool_result', tool: 'decisions', text: `${r.provider || 'decisions'} ${r.model || ''}${d.calibrated ? ', calibrated' : ', estimated'}`.trim() });
        return { text, sources: [], model: r.model ? `${r.provider ? `${r.provider}/` : ''}${r.model}` : 'decisions', decision: { type: a.type, answer: a, calibrated: Boolean(d.calibrated), question } };
    }

    return { model, decisions };
}

module.exports = { createEngines, parseEngine, engineOf, label, keyOf, ENGINES, HARNESSES, KINDS };
