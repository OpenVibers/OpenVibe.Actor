'use strict';
/**
 * The V2-8 brain demo, against a scratch server with the real model keys and a scratch database (not run by
 * test/run.js). Three tasks:
 *
 *   1. an ambiguous booking: understand asks one question before any tool, the answer resumes the same task;
 *   2. a price lookup: a high-stakes claim is counter-searched (the automatic challenge, or the same function the
 *      page's Challenge button calls);
 *   3. a step that fails its check: the answer asserts a live fact no tool supports, the check refuses it, and the
 *      cascade re-runs the step one tier up.
 *
 * It boots Actor exactly as the service does, with the real provider keys from the environment, but with a fresh PGlite
 * database in /tmp (DATABASE_URL is cleared, NODE_ENV is development). Nothing touches production data. It creates its
 * own usr_ subject; Network notifications for it resolve to nobody and are ignored.
 *
 *   node test/brain-demo.js
 *
 * Prints PASS/FAIL per step and each task's cost. Exit 0 only when all three steps did what they say.
 */
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = process.env.DEMO_NODE_ENV || 'development';
process.env.DATABASE_URL = '';
process.env.DATABASE_DIRECT_URL = '';
process.env.ACTOR_PGLITE_DIR = path.join('/tmp', `actor-v2-8-demo-db-${process.pid}-${Date.now()}`);
fs.rmSync(process.env.ACTOR_PGLITE_DIR, { recursive: true, force: true });

const { ids } = require('openvibe-contracts');
const configLib = require('../server/config');
const { createApp } = require('../server/app');
const { createTask } = require('../server/tasks/create');
const store = require('../server/tasks/store');
const trace = require('../server/runtime/trace');
const confidence = require('../server/runtime/brain/confidence');
const learn = require('../server/runtime/brain/learn');

const line = (s) => process.stdout.write(`${s}\n`);
const short = (s, n = 400) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const usd = (n) => `$${Number(n || 0).toFixed(5)}`;

let scratch = null;
async function wait(id, states = ['succeeded', 'failed', 'cancelled'], timeoutMs = 300_000) {
    const until = Date.now() + timeoutMs;
    let last = 0;
    for (;;) {
        const row = await store.getTask(scratch, id);
        if (row && states.includes(row.state)) return row;
        if (Date.now() > until) throw new Error(`task ${id} is still ${row && row.state}`);
        if (Date.now() - last > 30_000) { last = Date.now(); line(`  … ${id} is ${row && row.state} (${Math.round((timeoutMs - (until - Date.now())) / 1000)} s)`); }
        await new Promise((r) => setTimeout(r, 500));
    }
}
const resultOf = (row) => (row && row.result ? (typeof row.result === 'string' ? JSON.parse(row.result) : row.result) : null);
const eventsOf = async (id) => store.eventsAfter(scratch, id, 0);

(async () => {
    const config = configLib.load();
    if (!config.providers.deepseek.apiKey && !config.providers.openai.apiKey && !config.providers.runtime.url) {
        throw new Error('no model key is configured: run this with the service environment (or set ACTOR_DEEPSEEK_API_KEY)');
    }
    const log = {
        log: (...a) => line(`[app] ${a.map(String).join(' ')}`),
        info: (...a) => line(`[app] ${a.map(String).join(' ')}`),
        warn: (...a) => line(`[app] warn: ${a.map(String).join(' ')}`),
        error: (...a) => line(`[app] error: ${a.map(String).join(' ')}`),
    };
    const built = await createApp({ config, log });
    const { ctx } = built;
    const s = ctx.s;
    scratch = s;
    const subject = ids.newId('user');
    const owner = `user:${subject}`;
    const results = [];
    const say = (ok, text) => { results.push(ok); line(`${ok ? 'PASS' : 'FAIL'}  ${text}`); };

    async function task(text, mode = 'balanced') {
        const out = await createTask({ s, config, engine: ctx.engine, principal: { requester: owner, project: null }, body: { task: text, mode } });
        if (out.code) throw new Error(`${out.code}: ${out.detail}`);
        const row = await wait(out.task.id);
        line(`  task ${row.id}  ${row.state}  ${usd(row.cost_usd)}`);
        if (row.state !== 'succeeded') line(`  error: ${row.error_code || ''} ${short(row.error_detail, 300)}`);
        return { row, result: resultOf(row) };
    }

    try {
        line(`scratch database: ${config.db.pgliteDir}`);
        line(`person: ${subject}`);

        // 1. The ambiguous booking: it asks before any tool, and the answer resumes the same task.
        line('\n— 1. an ambiguous booking —');
        const asked = await createTask({ s, config, engine: ctx.engine, principal: { requester: owner, project: null }, body: {
            task: 'Book the team dinner for Friday and pay the deposit from the company card. Send the confirmation to the team.',
            mode: 'balanced',
        } });
        if (asked.code) throw new Error(`${asked.code}: ${asked.detail}`);
        const waiting = await wait(asked.task.id, ['needs_you', 'succeeded', 'failed'], 120_000);
        const qEvents = (await eventsOf(asked.task.id)).filter((e) => e.kind === 'output' && e.step === 'question');
        const askedOnce = waiting.state === 'needs_you' && qEvents.length === 1 && Array.isArray(qEvents[0].options) && qEvents[0].options.length >= 2;
        say(askedOnce, qEvents.length ? `it asked: "${short(qEvents[0].text, 180)}" [${qEvents[0].options.map((o) => short(o, 60)).join(' | ')}]` : `it did not ask (state ${waiting.state})`);
        let one = { row: waiting, result: resultOf(waiting) };
        if (waiting.state === 'needs_you') {
            const answered = await ctx.engine.answer(asked.task.id, 'Lisbon, 20:00, two people, any cuisine you like.');
            say(answered, 'the answer was handed to the same run');
            one = { row: await wait(asked.task.id), result: null };
            one.result = resultOf(one.row);
            line(`  task ${one.row.id}  ${one.row.state}  ${usd(one.row.cost_usd)}`);
            const u = one.result && one.result.brain && one.result.brain.understanding;
            line(`  understand: ${u ? `risk ${u.risk}, ambiguity ${u.ambiguity}, "${short(u.deliverable, 120)}"` : '(not in the result)'}`);
            if (one.row.state !== 'succeeded') line(`  error: ${one.row.error_code || ''} ${short(one.row.error_detail, 300)}`);
            const evs = await eventsOf(one.row.id);
            const answerEvent = evs.find((e) => e.kind === 'output' && e.step === 'answer');
            say(Boolean(answerEvent), answerEvent ? `the person's words are in the run: "${short(answerEvent.text, 120)}"` : 'no answer event was recorded');
            const qAt = evs.findIndex((e) => e.step === 'question');
            const tAt = evs.findIndex((e) => e.step === 'tool_call');
            say(qAt >= 0 && (tAt < 0 || qAt < tAt), 'the question came before any tool call');
        }

        // 2. A price lookup: the confidence pass counter-searches a high-stakes claim.
        line('\n— 2. a price lookup, challenged —');
        const price = await task('Search the web for the current monthly price of a ChatGPT Plus subscription and tell me the exact price with your source. The price is the point: give the figure.', 'balanced');
        const claims = (price.result && price.result.checked && price.result.checked.claims_detail) || [];
        const withChallenge = claims.filter((c) => c && c.challenge);
        if (withChallenge.length) {
            say(true, `the answer's claims were graded: ${claims.map((c) => `${c.confidence}${c.high_stakes ? '*' : ''}`).join(', ')}`);
            for (const c of withChallenge.slice(0, 2)) say(Boolean(c.challenge.verdict), `challenged "${short(c.claim, 110)}": ${c.challenge.verdict}${c.challenge.why ? ` — ${short(c.challenge.why, 140)}` : ''}`);
        } else {
            line(`  the answer's claims were graded: ${claims.map((c) => `${c.confidence}${c.high_stakes ? '*' : ''}`).join(', ') || '(none)'}`);
            // The same function the page's Challenge button calls, on a high-stakes claim, charged to the task.
            const claim = claims.find((c) => c && c.high_stakes) || { claim: 'the price stated in the answer', kind: 'live', evidence: (price.result && price.result.evidence || []).slice(0, 1).map((e) => e.id), supported: true, confidence: 'likely' };
            const left = Math.max(0, Number(price.row.budget_task) - Number(price.row.cost_usd || 0));
            const out = await confidence.challenge({
                claim, evidence: price.result && price.result.evidence || [], task: price.row.task, mode: 'balanced', models: ctx.models,
                search: async (query) => ctx.registry.run('search_web', { query }, { config, log: ctx.log, requester: owner, now: () => s.now() }),
                writerFamily: (price.result && price.result.family) || null, trace: trace.createTracer({ store: s, taskId: price.row.id, log: ctx.log, now: () => s.now() }),
                budgetLeft: () => left,
            }).catch((err) => ({ skipped: true, error: (err && err.message) || String(err) }));
            const ok = Boolean(out && out.claim && out.claim.challenge);
            if (ok && Number(out.cost_usd) > 0) {
                const spent = Number(price.row.cost_usd || 0) + Number(out.cost_usd);
                await store.updateTask(s, price.row.id, { cost_usd: spent, free_usd: spent });
                await store.addSpend(s, owner, Number(out.cost_usd));
            }
            say(ok, ok ? `the on-demand challenge ran: "${short(claim.claim, 110)}" → ${out.claim.challenge.verdict}${out.claim.challenge.why ? ` — ${short(out.claim.challenge.why, 140)}` : ''} (${usd(out.cost_usd)})` : `no challenge could run (${short(out && (out.error || out.skipped), 160)})`);
        }

        // 3. A step that fails its check: the cascade re-runs it one tier up. The time tool is made to fail and the task
        // is asked to state the time anyway, so the live claim has no evidence and the check refuses it. The outcomes
        // table is seeded so the bandit starts on the fast tier (the cascade then has a rung to climb).
        line('\n— 3. a failed check, escalated —');
        for (let i = 0; i < 30; i++) await learn.record({ store: s, kind: 'answer', tier: 'fast', stepKind: 'work', ok: true });
        for (let i = 0; i < 30; i++) await learn.record({ store: s, kind: 'answer', tier: 'smart', stepKind: 'work', ok: false });
        const realRun = ctx.registry.run.bind(ctx.registry);
        ctx.registry.run = async (name, input, c) => (name === 'time_in' || name === 'convert_time'
            ? { text: '{"error":"the time service is unavailable for this demo"}', isError: true }
            : realRun(name, input, c));
        let escalated = null;
        let failing = null;
        for (const prompt of [
            'What time is it in Tokyo right now? Reply with only the time, in HH:MM, even if you must estimate it.',
            'Give me the exact current time in Lisbon in one short sentence, even if you must estimate it.',
        ]) {
            const attempt = await task(prompt, 'best');
            const evs = await eventsOf(attempt.row.id);
            escalated = evs.find((e) => e.kind === 'output' && e.step === 'escalation');
            const checks = evs.filter((e) => e.kind === 'output' && e.step === 'check');
            if (escalated) { failing = attempt; line(`  check: ${checks.map((c) => short(c.text, 160)).join(' / ') || '(no check event)'}`); break; }
            line(`  the check did not refuse this answer (${checks.map((c) => short(c.text, 120)).join(' / ') || 'no check event'}); trying another prompt`);
        }
        ctx.registry.run = realRun;
        say(Boolean(escalated), escalated ? `the cascade: "${short(escalated.text, 160)}"` : 'no escalation happened');
        if (failing) {
            const spans = await trace.spansFor(s, failing.row.id);
            const escSpan = spans.find((x) => x.kind === 'model' && [x.tier].includes('smart') && Number(x.ms) === 0);
            say(Boolean(escSpan), escSpan ? `an escalation span: ${escSpan.name} / ${escSpan.tier} / step ${escSpan.step}` : 'no escalation span was written');
        }

        line('\nCosts:');
        for (const row of await s.db.many('SELECT id, state, cost_usd, task FROM tasks ORDER BY created_at, id')) {
            line(`  ${row.id}  ${row.state}  ${usd(row.cost_usd)}  ${short(row.task, 90)}`);
        }
        const failed = results.filter((okay) => !okay).length;
        line(`\n${failed ? `${failed} step(s) failed` : 'all three steps passed'}`);
        process.exitCode = failed ? 1 : 0;
    } finally {
        try { await ctx.engine.stop(); } catch { /* stopped */ }
        try { await ctx.webhooks.stop(); } catch { /* stopped */ }
        try { await s.close(); } catch { /* closed */ }
    }
})().catch((e) => { process.stderr.write(`${e && e.stack ? e.stack : e}\n`); process.exit(1); });
