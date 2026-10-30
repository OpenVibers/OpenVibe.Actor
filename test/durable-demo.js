'use strict';
/**
 * The V2-9 durable-runs demo, against a scratch server with the real model keys and a scratch PGlite database (not run
 * by test/run.js). Three parts:
 *
 *   1. a task is interrupted (the worker is stopped) after its first checkpoint, then a new process resumes it from
 *      that checkpoint with a fresh engine on the same database;
 *   2. the resumed run is forked from its first step onto the "best" tier, with its own budget;
 *   3. the two runs are compared: answers, cost, time, steps and the claims that differ.
 *
 * It boots Actor as the service does, with the real provider keys from the environment, but with a fresh PGlite
 * database in /tmp (DATABASE_URL is cleared, NODE_ENV is development) and a fresh ACTOR_CHECKPOINT_KEY generated for
 * this process only. Nothing touches production data. The key is never printed.
 *
 *   node test/durable-demo.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

process.env.NODE_ENV = process.env.DEMO_NODE_ENV || 'development';
process.env.DATABASE_URL = '';
process.env.DATABASE_DIRECT_URL = '';
process.env.ACTOR_PGLITE_DIR = path.join('/tmp', `actor-v2-9-demo-db-${process.pid}-${Date.now()}`);
// A scratch key: the demo proves sealing, and the production environment must not have one while this stage is reviewed.
process.env.ACTOR_CHECKPOINT_KEY = crypto.randomBytes(32).toString('hex');
process.env.ACTOR_LOOP_SELF_REFLECTIONS = '0';
fs.rmSync(process.env.ACTOR_PGLITE_DIR, { recursive: true, force: true });

const { ids } = require('openvibe-contracts');
const configLib = require('../server/config');
const { createApp } = require('../server/app');
const { createTask } = require('../server/tasks/create');
const store = require('../server/tasks/store');
const trace = require('../server/runtime/trace');
const benchOffers = require('../server/tasks/bench-offers');
const compare = require('../server/tasks/compare');

const line = (s) => process.stdout.write(`${s}\n`);
const short = (s, n = 400) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const usd = (n) => `$${Number(n || 0).toFixed(5)}`;
const resultOf = (row) => (row && row.result ? (typeof row.result === 'string' ? JSON.parse(row.result) : row.result) : null);
const eventsOf = (s, id) => store.eventsAfter(s, id, 0);

let scratch = null;
async function wait(id, states = ['succeeded', 'failed', 'cancelled'], timeoutMs = 300_000) {
    const until = Date.now() + timeoutMs;
    let last = 0;
    for (;;) {
        const row = await store.getTask(scratch, id);
        if (row && states.includes(row.state)) return row;
        if (Date.now() > until) throw new Error(`task ${id} is still ${row && row.state}`);
        if (Date.now() - last > 30_000) { last = Date.now(); line(`  … ${id} is ${row && row.state} (${Math.round((timeoutMs - (until - Date.now())) / 1000)} s)`); }
        await new Promise((r) => setTimeout(r, 250));
    }
}

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
    const results = [];
    const say = (ok, text) => { results.push(ok); line(`${ok ? 'PASS' : 'FAIL'}  ${text}`); };

    const first = await createApp({ config, log });
    const s = first.ctx.s;
    scratch = s;
    const subject = ids.newId('user');
    const owner = `user:${subject}`;
    let second = null;
    try {
        line(`scratch database: ${config.db.pgliteDir}`);
        line(`person: ${subject}`);
        line(`checkpoints: ${first.ctx.checkpoints.enabled ? 'on (a scratch key, not printed)' : 'OFF'} (key ${config.checkpoints.key ? 'set' : 'missing'})`);

        // 1. A task interrupted after its first checkpoint.
        line('\n— 1. interrupted, then resumed —');
        const created = await createTask({ s, config, engine: first.ctx.engine, principal: { requester: owner, project: null }, body: {
            task: 'What time is it in Lisbon right now? Use the time_in tool, then tell me the local time and the day in one short answer.',
            mode: 'balanced',
        } });
        if (created.code) throw new Error(`${created.code}: ${created.detail}`);
        const id = created.task.id;
        let saved = [];
        const until = Date.now() + 180_000;
        while (!saved.length && Date.now() < until) {
            saved = await first.ctx.checkpoints.list(id);
            if (!saved.length) await new Promise((r) => setTimeout(r, 50));
        }
        if (!saved.length) throw new Error('no checkpoint was written: the task may have answered without a tool');
        const beforeStop = await store.getTask(s, id);
        line(`  first checkpoint at step ${saved[0].step} (task ${beforeStop.state}, ${usd(beforeStop.cost_usd)})`);
        await first.ctx.engine.stop();
        const interrupted = await wait(id, ['running', 'needs_you', 'succeeded', 'failed', 'cancelled'], 30_000);
        say(interrupted.state === 'running', `the worker was stopped and the task is left open (state ${interrupted.state})`);
        if (interrupted.state !== 'running') throw new Error('the task finished before it could be interrupted; run the demo again');

        // A new process on the same store: a fresh engine, loop and checkpoint reader.
        second = await createApp({ config, store: s, log });
        const boot = await second.ctx.engine.resumeInterrupted();
        say(boot.resumed.includes(id), `boot resumed ${boot.resumed.length} task(s) from their checkpoints`);
        const resumed = await wait(id);
        const resumedResult = resultOf(resumed);
        say(resumed.state === 'succeeded', `the resumed task finished (${resumed.state}, ${usd(resumed.cost_usd)}${resumed.error_detail ? `: ${short(resumed.error_detail, 200)}` : ''})`);
        say(Number(resumed.resumes) === 1, `the task's resume count is ${resumed.resumes}`);
        const resumedEvents = await eventsOf(s, id);
        const resumeEvent = resumedEvents.find((e) => e.step === 'resume');
        say(Boolean(resumeEvent && /Picked up after a restart at step/.test(String(resumeEvent.text))), resumeEvent ? `the page event: "${short(resumeEvent.text, 160)}"` : 'no resume event');
        const resumeSpan = (await trace.spansFor(s, id)).find((sp) => sp.kind === 'tool' && sp.name === 'resume');
        say(Boolean(resumeSpan), resumeSpan ? `the span: ${resumeSpan.name} at step ${resumeSpan.step}` : 'no resume span');
        line(`  answer: ${short(resumedResult && resumedResult.answer, 300)}`);
        const allSaved = await second.ctx.checkpoints.list(id);
        say(allSaved.length >= saved.length + 1, `${allSaved.length} checkpoints saved: steps ${allSaved.map((x) => x.step).join(', ')}`);
        const firstCp = await second.ctx.checkpoints.at(id, saved[0].step);
        const toolRuns = (firstCp.state.ledger || []).map((e) => e.tool);
        line(`  the checkpoint holds ${(firstCp.state.ledger || []).length} evidence item(s) from before the restart: ${toolRuns.join(', ')}`);

        // 2. Fork from the first step on a stronger tier.
        line('\n— 2. a fork from step ' + saved[0].step + ', on the best tier —');
        const forkOut = await createTask({ s, config, engine: second.ctx.engine, principal: { requester: owner, project: null }, body: {
            task: resumed.task, mode: 'best',
        }, parentId: id, forkOfStep: saved[0].step, forkChange: { kind: 'tier', tier: 'best' } });
        if (forkOut.code) throw new Error(`${forkOut.code}: ${forkOut.detail}`);
        const fork = await wait(forkOut.task.id);
        const forkResult = resultOf(fork);
        say(fork.state === 'succeeded', `the fork finished (${fork.state}, ${usd(fork.cost_usd)}${fork.error_detail ? `: ${short(fork.error_detail, 200)}` : ''})`);
        say(fork.fork_of_step != null && fork.parent_id === id, `it is a new task from step ${fork.fork_of_step} of ${id}`);
        say(forkResult && forkResult.tier === 'best', `it ran on ${forkResult && forkResult.tier} (mode ${fork.mode})`);
        const forkCp = await second.ctx.checkpoints.last(fork.id);
        const parentCp = await second.ctx.checkpoints.at(id, saved[0].step);
        const forkAllow = new Set((forkCp && forkCp.state.allow) || []);
        const parentAllow = new Set((parentCp && parentCp.state.allow) || []);
        say([...forkAllow].every((name) => parentAllow.has(name)), `its allow-list is at most the parent's (${forkAllow.size} vs ${parentAllow.size} tools)`);
        line(`  fork answer: ${short(forkResult && forkResult.answer, 300)}`);

        // 3. Compare.
        line('\n— 3. the two runs compared —');
        const [spansA, spansB, offerA, offerB] = await Promise.all([
            trace.spansFor(s, id), trace.spansFor(s, fork.id),
            benchOffers.get(s, id, owner), benchOffers.get(s, fork.id, owner),
        ]);
        const cmp = compare.compare(resumed, fork, { spansA, spansB, offerA, offerB, now: s.now() });
        line(`  A: ${usd(cmp.a.cost_usd)} · ${Math.round(cmp.a.time_ms / 1000)} s · ${cmp.a.turns} turns · ${cmp.a.tool_calls} tool calls · ${cmp.a.claims.length} claims`);
        line(`  B: ${usd(cmp.b.cost_usd)} · ${Math.round(cmp.b.time_ms / 1000)} s · ${cmp.b.turns} turns · ${cmp.b.tool_calls} tool calls · ${cmp.b.claims.length} claims`);
        line(`  A: ${short(cmp.a.answer, 300)}`);
        line(`  B: ${short(cmp.b.answer, 300)}`);
        line(`  claims only A: ${cmp.claims.only_a.length}; only B: ${cmp.claims.only_b.length}; graded differently: ${cmp.claims.changed.length}`);
        for (const c of [...cmp.claims.only_a.map((x) => `A · ${x.claim}`), ...cmp.claims.only_b.map((x) => `B · ${x.claim}`)].slice(0, 6)) line(`    ${short(c, 200)}`);
        say(Boolean(cmp.a.answer) && Boolean(cmp.b.answer), 'both runs have an answer to put side by side');
        say(cmp.a.step_count > 0 && cmp.b.step_count > 0, `both runs have steps (${cmp.a.step_count} and ${cmp.b.step_count} spans)`);
        say(Boolean(offerA) === Boolean(cmp.a.bench.offered) && Boolean(offerB) === Boolean(cmp.b.bench.offered), 'the Bench offer link follows the offer row');
        line(`  compare route: /tasks/${id}/compare/${fork.id}`);

        const failed = results.filter((ok) => !ok).length;
        line(`\n${failed ? `${failed} step(s) failed` : 'all durable-run steps passed'}`);
        process.exitCode = failed ? 1 : 0;
    } finally {
        try { await first.ctx.engine.stop(); } catch { /* stopped */ }
        try { await first.ctx.webhooks.stop(); } catch { /* stopped */ }
        if (second) {
            try { await second.ctx.engine.stop(); } catch { /* stopped */ }
            try { await second.ctx.webhooks.stop(); } catch { /* stopped */ }
            try { second.ctx.keys.client.stop(); } catch { /* stopped */ }
        }
        try { first.ctx.keys.client.stop(); } catch { /* stopped */ }
        try { await s.close(); } catch { /* closed */ }
        try { await first.ctx.webhooks.stop(); } catch { /* stopped */ }
        try { await first.ctx.vibeDelivery.stop(); } catch { /* stopped */ }
        try { await second.ctx.vibeDelivery.stop(); } catch { /* stopped */ }
    }
})().catch((e) => { process.stderr.write(`${e && e.stack ? e.stack : e}\n`); process.exit(1); });
