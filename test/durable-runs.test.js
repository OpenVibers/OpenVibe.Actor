'use strict';
/**
 * Durable runs (Actor v2, stage V2-9): a sealed checkpoint after every step, resume after a simulated crash with no
 * tool re-run, the resume cap, a fork with a tier change / an edited step / a tool removed, and the compare page's
 * owner check. Also the checkpoint table's account-data place and pruning.
 *
 * The checkpoint key is random per run: no fixture key is ever written in the repository or the log.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, check, done } = require('./helpers/boot');
const store = require('../server/tasks/store');
const trace = require('../server/runtime/trace');
const { createCheckpoints } = require('../server/runtime/checkpoints');
const { snapshot, restore } = require('../server/runtime/checkpoint-state');
const { testDb } = require('./helpers/db');
const { createStore } = require('../server/db');
const { createApp } = require('../server/app');
const { createLedger } = require('../server/runtime/evidence');
const benchOffers = require('../server/tasks/bench-offers');
const compare = require('../server/tasks/compare');
const accountData = require('../server/identity/account-data');
const { uncovered } = require('openvibe-sdk/account-data');

const KEY = crypto.randomBytes(32).toString('hex');
const SAME = { 'sec-fetch-site': 'same-origin' };
const SELF = 'user:usr_01JZ0000000000000000000AAA';
const quiet = { log() {}, info() {}, warn() {}, error() {} };
const taskIdOf = (res) => String(res.headers.get('location') || '').split('/').filter(Boolean).pop();
const waitFor = async (fn, ms = 10_000) => {
    const until = Date.now() + ms;
    for (;;) {
        const value = await fn();
        if (value) return value;
        if (Date.now() > until) throw new Error('timed out waiting');
        await new Promise((r) => setTimeout(r, 25));
    }
};

function minimalState(task, calls = 0) {
    return {
        task, requester: SELF, taskId: null, mode: 'balanced', tier: 'smart', baseTier: 'smart', signal: null,
        messages: [], lastText: '', answered: false, model: null, family: null, provider: null, calls,
        ledger: createLedger(), plan: { assumptions: [], steps: [{ goal: 'Do it', state: 'active' }] },
        counts: new Map(), stopped: null, selfReflections: 0, readOutside: false, ctx: null, context: [], depth: 0, tools: [], allow: null,
        brain: {
            understanding: null, kind: 'answer', personAnswer: null, ledger: null, progressLedger: require('../server/runtime/brain/ledger').createProgress(),
            progress: null, prior: new Map(), steps: [], tiers: new Set(), tools: new Set(), demoted: [], triedTiers: [], triedTools: [],
            questions: 0, toolRuns: 0, escalations: require('../server/runtime/brain/escalate').createEscalations(), lastTool: null, lastLine: null,
        },
    };
}

(async () => {
    await check('the seal round-trips and is bound to the task and the step (AAD)', async () => {
        const d = await testDb();
        try {
            const s = createStore(d.db, { now: () => Date.now() });
            const cp = createCheckpoints({ store: s, config: { checkpoints: { key: KEY } }, log: quiet });
            assert.strictEqual(cp.enabled, true);
            const sealed = cp.seal('{"messages":[]}', cp.aad('tsk_one', 3));
            assert.ok(sealed.startsWith('v1:'), 'the OpenVibe.AI v1 format');
            assert.strictEqual(cp.open(sealed, cp.aad('tsk_one', 3)), '{"messages":[]}');
            assert.throws(() => cp.open(sealed, cp.aad('tsk_two', 3)), /authenticate|state/i, 'another task does not open it');
            assert.throws(() => cp.open(sealed, cp.aad('tsk_one', 4)), /authenticate|state/i, 'another step does not open it');
        } finally { await d.close(); }
    });

    await check('without the key checkpoints are off, and nothing is written', async () => {
        const d = await testDb();
        try {
            const s = createStore(d.db, { now: () => Date.now() });
            const cp = createCheckpoints({ store: s, config: { checkpoints: { key: '' } }, log: quiet });
            assert.strictEqual(cp.enabled, false);
            assert.strictEqual(await cp.save({ taskId: 'tsk_none', step: 1, state: { v: 1 } }), null);
            assert.strictEqual(await cp.last('tsk_none'), null);
            assert.deepStrictEqual(await cp.list('tsk_none'), []);
            const n = Number(await s.db.value("SELECT count(*) FROM information_schema.tables WHERE table_name = 'actor_checkpoints'"));
            assert.strictEqual(n, 1, 'the expand migration ran even with checkpoints off');
        } finally { await d.close(); }
    });

    await check('save, read and prune: the last 50 per task, the state restored item by item', async () => {
        const d = await testDb();
        try {
            const s = createStore(d.db, { now: () => Date.now() });
            const cp = createCheckpoints({ store: s, config: { checkpoints: { key: KEY, keep: 3 } }, log: quiet });
            const id = s.newId('tsk');
            await store.insertTask(s, { id, requester: SELF, task: 'Find the facts', mode: 'balanced', budget_task: 0.05, budget_day: 0.25, created_at: s.iso() });
            const original = minimalState('Find the facts', 1);
            original.ledger.add({ tool: 'search_web', input: { query: 'facts' }, text: 'A source', sources: [{ url: 'https://example.org/a', title: 'A' }] });
            const snap = snapshot(original, { spent: 0.001 });
            for (let step = 1; step <= 5; step++) {
                await cp.save({ taskId: id, step, state: { ...snap, calls: step } });
            }
            assert.strictEqual(await cp.count(id), 3, 'only the newest 3 are kept');
            assert.deepStrictEqual((await cp.list(id)).map((r) => r.step), [3, 4, 5]);
            const last = await cp.last(id);
            assert.strictEqual(last.step, 5);
            assert.strictEqual(last.state.spent, 0.001);
            const restored = restore(last.state);
            assert.ok(restored, 'the state restores');
            assert.strictEqual(restored.task, 'Find the facts');
            assert.strictEqual(restored.ledger.items.length, 1);
            assert.strictEqual(restored.ledger.items[0].id, 'E1');
            assert.strictEqual(restored.ledger.items[0].sources[0].url, 'https://example.org/a');
            // A secret-shaped value and a result a tool marked secret are never in the sealed row. The token is built
            // at run time so no scanner sees a credential-shaped literal in this file.
            const FAKE = ['sk', 'fixture', 'not', 'a', 'real', 'credential'].join('-');
            const secretState = snapshot(minimalState('Secret test', 2), { spent: 0 });
            secretState.ledger.push({ id: 'E1', tool: 'vault', secret: true, text: `the key is ${FAKE}`, data: { api_key: FAKE } });
            secretState.brain.understanding = { apiKey: FAKE, deliverable: 'x' };
            await cp.save({ taskId: id, step: 6, state: secretState });
            const raw = await s.db.value('SELECT state_enc FROM actor_checkpoints WHERE task_id = $1 AND step = 6', [id]);
            assert.ok(!raw.includes(FAKE), 'the credential is not in the ciphertext');
            const opened = await cp.at(id, 6);
            assert.ok(!JSON.stringify(opened.state).includes(FAKE), 'and not after opening it');
            assert.strictEqual(opened.state.ledger[0].secret, true);
        } finally { await d.close(); }
    });

    await check('checkpoints go with their task and are exported with the person, and the account guard passes', async () => {
        const d = await testDb();
        try {
            const s = createStore(d.db, { now: () => Date.now() });
            const cp = createCheckpoints({ store: s, config: { checkpoints: { key: KEY } }, log: quiet });
            const subject = 'usr_01JZ0000000000000000000CCC';
            const id = s.newId('tsk');
            await store.insertTask(s, { id, requester: `user:${subject}`, task: 'Mine', mode: 'balanced', budget_task: 0.05, budget_day: 0.25, created_at: s.iso() });
            await cp.save({ taskId: id, step: 1, state: snapshot(minimalState('Mine', 1), { spent: 0.001 }) });
            const parts = await accountData.exportCheckpoints(d.db, subject);
            assert.strictEqual(parts.length, 1);
            assert.strictEqual(parts[0].name, 'checkpoints.json');
            assert.strictEqual(parts[0].content[0].task_id, id);
            assert.strictEqual(parts[0].content[0].step, 1);
            assert.ok(!('state_enc' in parts[0].content[0]), 'the sealed state is not exported');
            assert.deepStrictEqual(await uncovered(d.db, { tables: accountData.TABLES, exempt: { account_data_events: 'the ledger of requests itself', actor_brain_outcomes: 'counts only' } }), [], 'the guard passes');
            await s.db.query('DELETE FROM tasks WHERE id = $1', [id]);
            assert.strictEqual(await cp.count(id), 0, 'erased with the task');
        } finally { await d.close(); }
    });

    await check('the compare function lists claims only one run has, and the same claim graded differently', async () => {
        const diff = compare.compareClaims(
            [{ claim: 'The price is $20.', confidence: 'sure', evidence: ['E1'] }, { claim: 'The sky is blue.', confidence: 'likely', evidence: ['E1'] }],
            [{ claim: 'The price is $20!', confidence: 'likely', evidence: ['E1'] }, { claim: 'The sea is deep.', confidence: 'sure', evidence: ['E2'] }],
        );
        assert.deepStrictEqual(diff.only_b.map((c) => c.claim), ['The sea is deep.']);
        assert.strictEqual(diff.only_a.length, 1);
        assert.strictEqual(diff.changed.length, 1);
        assert.strictEqual(diff.changed[0].a.confidence, 'sure');
        assert.strictEqual(diff.changed[0].b.confidence, 'likely');
    });

    // ── A crash and a resume, on the real engine ──────────────
    await check('a checkpoint after every step; a killed worker resumes from it, the tool is not run again, and a span and an event say so', async () => {
        const t = await boot({ env: { ACTOR_CHECKPOINT_KEY: KEY } });
        let second = null;
        try {
            t.config.loop.selfReflections = 0;
            const bea = t.network.addUser('bea');
            const owner = `user:${bea.subject}`;
            t.providers.reset();
            t.providers.state.smart = 'tool';
            t.providers.state.loopTool = { name: 'calculate', arguments: JSON.stringify({ expression: '2+2' }) };
            // The first loop turn calls calculate; the second hangs, so the first checkpoint exists when the worker dies.
            t.providers.state.hangAfterCalls = 1;
            const created = await t.get('/api/v1/tasks', { as: bea, json: { task: 'What is two plus two?', mode: 'balanced' }, headers: SAME });
            assert.strictEqual(created.status, 201, created.text);
            const id = created.json().id;
            const firstCp = await waitFor(async () => {
                const list = await t.ctx.checkpoints.list(id);
                return list.length ? list : null;
            });
            assert.strictEqual(firstCp[0].step, 1, 'the checkpoint landed after the first step');
            await waitFor(() => t.providers.loopCalls() >= 2);
            assert.ok(t.providers.loopCalls() >= 2, 'the second model call was in flight');
            await t.ctx.engine.stop();
            const interrupted = await waitFor(async () => {
                const row = await store.getTask(t.ctx.s, id);
                return row && row.state === 'running' ? row : null;
            });
            assert.strictEqual(interrupted.state, 'running', 'a stop leaves it open, not failed');
            t.providers.state.hangAfterCalls = null;

            // A new process: same store, same key, a fresh engine and loop.
            second = await createApp({ config: t.config, store: t.ctx.s, log: quiet });
            const bootOut = await second.ctx.engine.resumeInterrupted();
            assert.deepStrictEqual(bootOut.resumed, [id]);
            const ended = await t.waitFor(id);
            assert.strictEqual(ended.state, 'succeeded', ended.error_detail || '');
            assert.strictEqual(Number(ended.resumes), 1);
            const events = await store.eventsAfter(t.ctx.s, id, 0);
            assert.ok(events.some((e) => e.step === 'resume' && /Picked up after a restart at step 1/.test(String(e.text))), 'the page event says where it resumed');
            assert.strictEqual(events.filter((e) => e.step === 'tool_call' && e.tool === 'calculate').length, 1, 'the checkpointed tool call is not run again');
            const spans = await trace.spansFor(t.ctx.s, id);
            assert.ok(spans.some((sp) => sp.kind === 'tool' && sp.name === 'resume'), 'the resume is a span');
            assert.ok(spans.every((sp) => !JSON.stringify(sp).includes('Stand-in answer')), 'no checkpoint content in a span');
            const saved = await t.ctx.checkpoints.list(id);
            assert.deepStrictEqual(saved.map((r) => r.step), [1, 2], 'a checkpoint after the interrupted step and after the answer');
            assert.ok(!t.logs().includes('state_enc'), 'no sealed state is logged');
            const enc = await t.ctx.s.db.value('SELECT state_enc FROM actor_checkpoints WHERE task_id = $1 AND step = 1', [id]);
            assert.ok(String(enc).startsWith('v1:') && !String(enc).includes('two plus two'), 'the saved state is sealed');

            // The resume cap: two resumes already spent, so the next interruption fails it and says why.
            const capId = t.ctx.s.newId('tsk');
            await store.insertTask(t.ctx.s, { id: capId, requester: owner, task: 'A task interrupted twice', mode: 'balanced', budget_task: 0.05, budget_day: 0.25, created_at: t.ctx.s.iso() });
            await store.updateTask(t.ctx.s, capId, { state: 'running', resumes: 2 });
            await second.ctx.checkpoints.save({ taskId: capId, step: 1, state: { v: 1 } });
            const capped = await second.ctx.engine.resumeInterrupted();
            assert.ok(capped.failed.includes(capId));
            const failed = await store.getTask(t.ctx.s, capId);
            assert.strictEqual(failed.state, 'failed');
            assert.match(String(failed.error_detail), /interrupted twice/);
            assert.strictEqual(Number(failed.resumes), 2, 'the cap is not raised by the failure');
        } finally {
            if (second) {
                await second.ctx.engine.stop().catch(() => {});
                await second.ctx.webhooks.stop().catch(() => {});
                second.ctx.keys.client.stop();
            }
            await t.close();
        }
    });

    // ── Fork and compare, on the real pages ──────────────
    await check('a fork with a stronger tier, one with an edited step, one with a tool removed: owner-only, same-origin, allow-list at most', async () => {
        const t = await boot({ env: { ACTOR_CHECKPOINT_KEY: KEY } });
        try {
            t.config.loop.selfReflections = 0;
            const zoe = t.network.addUser('zoe');
            const lee = t.network.addUser('lee');
            const owner = `user:${zoe.subject}`;
            t.providers.reset();
            t.providers.state.smart = 'tool';
            t.providers.state.loopTool = { name: 'calculate', arguments: JSON.stringify({ expression: '6*7' }) };
            const created = await t.get('/api/v1/tasks', { as: zoe, json: { task: 'What is six times seven?', mode: 'balanced' }, headers: SAME });
            const parentId = created.json().id;
            const parent = await t.waitFor(parentId);
            assert.strictEqual(parent.state, 'succeeded', parent.error_detail || '');
            const parentCp = await t.ctx.checkpoints.at(parentId, 1);
            assert.ok(parentCp, 'the parent has a step 1 checkpoint');
            const parentAllow = new Set(parentCp.state.allow || parentCp.state.tools || []);
            assert.ok(parentAllow.has('calculate'));

            const dialog = await t.get(`/tasks/${parentId}/fork?step=1`, { as: zoe });
            assert.strictEqual(dialog.status, 200);
            assert.match(dialog.text, /Fork from step 1/);
            assert.match(dialog.text, /Estimate:/);
            assert.match(dialog.text, /Run on another tier/);
            assert.match(dialog.text, new RegExp(`action="/tasks/${parentId}/fork"`));
            assert.strictEqual((await t.get(`/tasks/${parentId}/fork?step=1`, { as: lee })).status, 404, 'a stranger cannot open the fork dialog');
            assert.strictEqual((await t.get(`/tasks/${parentId}/fork`, { as: zoe, form: { step: '1', change: 'tier', tier: 'best' } })).status, 403, 'a fork needs this origin');

            // 1. Another tier.
            const tierFork = await t.get(`/tasks/${parentId}/fork`, { as: zoe, form: { step: '1', change: 'tier', tier: 'best' }, headers: SAME });
            assert.strictEqual(tierFork.status, 303, tierFork.text);
            const tierId = taskIdOf(tierFork);
            const tierRow = await t.waitFor(tierId);
            assert.strictEqual(tierRow.state, 'succeeded', tierRow.error_detail || '');
            assert.strictEqual(tierRow.parent_id, parentId);
            assert.strictEqual(Number(tierRow.fork_of_step), 1);
            const tierChange = typeof tierRow.fork_change === 'string' ? JSON.parse(tierRow.fork_change) : tierRow.fork_change;
            assert.deepStrictEqual(tierChange, { kind: 'tier', tier: 'best' });
            assert.strictEqual(tierRow.mode, 'best');
            const tierResult = typeof tierRow.result === 'string' ? JSON.parse(tierRow.result) : tierRow.result;
            assert.strictEqual(tierResult.tier, 'best', 'the fork ran on the tier the person picked');
            const tierCp = await t.ctx.checkpoints.last(tierId);
            assert.ok((tierCp.state.allow || []).every((name) => parentAllow.has(name)), 'a fork never gets more than the parent allow-list');

            // 2. An edited instruction for the same step.
            const text = 'Answer in one short line and say which calculation you used.';
            const editFork = await t.get(`/tasks/${parentId}/fork`, { as: zoe, form: { step: '1', change: 'instruction', instruction: text }, headers: SAME });
            assert.strictEqual(editFork.status, 303);
            const editId = taskIdOf(editFork);
            const editRow = await t.waitFor(editId);
            assert.strictEqual(editRow.state, 'succeeded', editRow.error_detail || '');
            const editChange = typeof editRow.fork_change === 'string' ? JSON.parse(editRow.fork_change) : editRow.fork_change;
            assert.deepStrictEqual(editChange, { kind: 'instruction', instruction: text });
            const editCp = await t.ctx.checkpoints.last(editId);
            assert.ok(JSON.stringify(editCp.state.messages).includes(text), 'the edited instruction is in the fork run');

            // 3. One tool off the allowed list.
            const toolFork = await t.get(`/tasks/${parentId}/fork`, { as: zoe, form: { step: '1', change: 'tool', tool: 'calculate' }, headers: SAME });
            assert.strictEqual(toolFork.status, 303);
            const toolId = taskIdOf(toolFork);
            const toolRow = await t.waitFor(toolId);
            assert.strictEqual(toolRow.state, 'succeeded', toolRow.error_detail || '');
            const toolCp = await t.ctx.checkpoints.last(toolId);
            assert.ok(!(toolCp.state.allow || []).includes('calculate'), 'the removed tool is not allowed in the fork');
            const toolChange = typeof toolRow.fork_change === 'string' ? JSON.parse(toolRow.fork_change) : toolRow.fork_change;
            assert.deepStrictEqual(toolChange, { kind: 'tool', tool: 'calculate' });

            assert.strictEqual((await t.get(`/tasks/${parentId}/fork`, { as: lee, form: { step: '1', change: 'tier', tier: 'best' }, headers: SAME })).status, 404, 'a stranger cannot fork');
            assert.strictEqual((await t.get(`/tasks/${parentId}/fork?step=99`, { as: zoe })).status, 404, 'a step that was never saved cannot be forked');

            // The page shows the saved steps, the fork links and the forks of the run.
            const page = await t.get(`/tasks/${parentId}`, { as: zoe });
            assert.match(page.text, /Steps saved/);
            assert.match(page.text, new RegExp(`href="/tasks/${parentId}/fork\\?step=1"`));
            assert.match(page.text, /Fork from step 1/);
            assert.match(page.text, /Forks and other runs/);

            // Compare: owner-only, both runs' answers, cost, steps, claims, Bench link.
            const answer = tierResult.answer || 'A stand-in answer';
            await benchOffers.offer(t.ctx.s, { taskId: parentId, owner, text: parent.task, answer });
            const cmp = await t.get(`/tasks/${parentId}/compare/${tierId}`, { as: zoe });
            assert.strictEqual(cmp.status, 200);
            assert.match(cmp.text, /Compare two runs/);
            assert.match(cmp.text, /Run A/);
            assert.match(cmp.text, /Run B/);
            assert.match(cmp.text, /Answer<\/label>/);
            assert.match(cmp.text, /Steps<\/label>/);
            assert.match(cmp.text, /Cost<\/label>/);
            assert.match(cmp.text, /Offered as a Bench case/);
            assert.match(cmp.text, /Claims that differ|The checked claims do not differ/);
            assert.strictEqual((await t.get(`/tasks/${parentId}/compare/${tierId}`, { as: lee })).status, 404, 'a stranger cannot compare');
            assert.strictEqual((await t.get(`/tasks/${parentId}/compare/${parentId}`, { as: zoe })).status, 303, 'the same run compares to itself by going back to it');
        } finally { await t.close(); }
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
