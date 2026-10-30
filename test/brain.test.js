'use strict';
/**
 * The brain's parts (Actor v2, stage V2-8), against scripted fake models and a scratch PGlite database:
 *   - understand asks only when the task is ambiguous AND high-risk, and code forces the high-risk cases;
 *   - the ledgers replan after two stalls, stop after a third, and a success resets them;
 *   - the bandit stays within the mode's tiers and never picks a call the budget cannot pay for;
 *   - a demoted tool is offered last, never removed;
 *   - confidence grades a direct tool, one source and no evidence; the challenge counter-searches a high-stakes price;
 *   - escalation never repeats the identical call and its caps hold;
 *   - an outcome is written, deduplicated, and a correction records failures plus a suggested memory;
 *   - the account-data guard sees the new table (in account-data.test.js).
 */
const assert = require('assert');
const { testDb } = require('./helpers/db');
const { createStore } = require('../server/db');
const { understand, normalize, shouldAsk } = require('../server/runtime/brain/understand');
const { taskLedger, createProgress, replan, ledgerText } = require('../server/runtime/brain/ledger');
const { allowedTiers, chooseTier, orderTools, loadPrior } = require('../server/runtime/brain/choose');
const { createEscalations, nextTier, nextTool } = require('../server/runtime/brain/escalate');
const { grade, challenge, review, isHighStakes, unsureLine } = require('../server/runtime/brain/confidence');
const learn = require('../server/runtime/brain/learn');

const results = [];
const ok = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { results.push(e); console.log(`  ✗ ${name}\n      ${(e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')}`); } };

const fast = (text) => ({ text: JSON.stringify(text), message: { role: 'assistant', content: JSON.stringify(text) }, usage: { input: 300, output: 80 }, cost_usd: 0.0001, model: 'fake-fast', family: 'fast-family', tier: 'fast' });
function fakeModels(reply) {
    const chats = [];
    return {
        chats,
        resolve(tier) { return { tier, provider: 'fake', model: `fake-${tier}`, family: 'fake', available: true, rates: { input_usd_per_mtok: 0, output_usd_per_mtok: 0 } }; },
        async chat(req) { chats.push({ ...req, messages: req.messages.map((m) => ({ ...m })) }); return typeof reply === 'function' ? reply(req) : fast(reply); },
    };
}

const call = (name, args = {}) => ({ function: { name, arguments: JSON.stringify(args) } });

(async () => {
    await ok('ambiguous + high risk asks once, with 2–4 options; ambiguous + low risk only states assumptions', async () => {
        const high = fakeModels({ ambiguity: 0.9, risk: 'high', kind: 'answer', deliverable: 'A plan', assumptions: ['a guess'], question: { text: 'Which city?', options: ['Lisbon', 'Porto', 'Faro'] } });
        const u = await understand({ task: 'Plan a trip', mode: 'balanced', models: high });
        assert.strictEqual(shouldAsk(u), true);
        assert.strictEqual(u.risk, 'high');
        assert.strictEqual(u.question.text, 'Which city?');
        assert.deepStrictEqual(u.question.options, ['Lisbon', 'Porto', 'Faro']);
        assert.strictEqual(u.cost_usd, 0.0001);

        const low = fakeModels({ ambiguity: 0.9, risk: 'low', kind: 'answer', deliverable: 'A summary', assumptions: ['a guess'], question: { text: 'Which part?', options: ['a', 'b'] } });
        const v = await understand({ task: 'Summarize this', mode: 'balanced', models: low });
        assert.strictEqual(shouldAsk(v), false);
        assert.strictEqual(v.question, null, 'a cheap mistake states its assumptions instead');
        assert.deepStrictEqual(v.assumptions, ['a guess']);
    });

    await ok('risk is high by code when the task spends money or acts outside, or is a best-mode run', async () => {
        const soft = fakeModels({ ambiguity: 0.9, risk: 'low', kind: 'answer', deliverable: 'Book it', question: { text: 'Which one?', options: ['a', 'b'] } });
        const buy = await understand({ task: 'Buy two tickets for the 8pm show', mode: 'balanced', models: soft });
        assert.strictEqual(buy.risk, 'high', 'spending money is high risk whatever the model said');
        assert.strictEqual(shouldAsk(buy), true);
        const best = normalize({ ambiguity: 0.9, risk: 'low', kind: 'answer', question: { text: 'Which?', options: ['a', 'b'] } }, { task: 'Plan the week', mode: 'best' });
        assert.strictEqual(best.risk, 'high', 'a long best-mode run is high risk');
        const short = normalize({ ambiguity: 0.2, risk: 'low', kind: 'answer' }, { task: 'Explain mutexes', mode: 'balanced' });
        assert.strictEqual(short.risk, 'low');
        assert.strictEqual(normalize({ question: { text: 'x', options: ['only one'] } }, { task: 'x' }).question, null, 'a question needs two options');
        assert.strictEqual(normalize({ ambiguity: 0.9, risk: 'high', question: { text: 'x', options: ['1', '2', '3', '4', '5'] } }, { task: 'x' }).question.options.length, 4, 'at most four');
    });

    await ok('the ledgers replan after two stalls, stop after a third, and a success resets the count', async () => {
        const progress = createProgress({ nextGoal: 'Find the price' });
        let u = progress.update({ okResults: 0, errorResults: 1 });
        assert.deepStrictEqual([u.stalls, u.replan, u.stuck], [1, false, false]);
        u = progress.update({ okResults: 0, errorResults: 1 });
        assert.deepStrictEqual([u.stalls, u.replan, u.stuck, u.replans], [2, true, false, 1]);
        u = progress.update({ okResults: 0, errorResults: 1 });
        assert.deepStrictEqual([u.stalls, u.stuck], [3, true]);
        const reset = createProgress();
        reset.update({ okResults: 0 });
        const back = reset.update({ okResults: 2 });
        assert.strictEqual(back.stalls, 0);
        assert.strictEqual(back.progressing, true);
        const done = reset.update({ answered: true });
        assert.strictEqual(done.done, true);
        assert.ok(!done.stuck);

        const plan = { steps: [{ goal: 'Find the price', state: 'active' }, { goal: 'Answer', state: 'pending' }] };
        const again = replan(plan, { nextGoal: 'Search another source' });
        assert.strictEqual(again.changed, true);
        assert.match(plan.steps[0].goal, /^Try another route: Search another source/);
        assert.match(ledgerText({ given: ['a'], lookup: ['b'], derive: ['c'], plan: plan.steps }, progress.snapshot()), /Task ledger: given a · find b · derive c/);
    });

    await ok('the bandit stays within the allowed tiers and never picks a call the budget cannot pay for', async () => {
        assert.deepStrictEqual(allowedTiers('balanced'), ['fast', 'smart']);
        assert.deepStrictEqual(allowedTiers('best'), ['fast', 'smart', 'best']);
        const models = fakeModels({});
        const stats = { forModel: async (id) => ({ n: 0, successRate: null, meanCostUsd: id === 'fake-fast' ? 0.0001 : id === 'fake-smart' ? 0.005 : 0.02 }) };
        const cheap = await chooseTier({ mode: 'balanced', kind: 'answer', budgetLeft: 0.001, models, stats, rng: () => 0.5 });
        assert.strictEqual(cheap.tier, 'fast', 'the only tier whose expected call fits');
        assert.ok(!cheap.candidates.find((c) => c.tier === 'smart').fits);
        const none = await chooseTier({ mode: 'balanced', kind: 'answer', budgetLeft: 0.00001, models, stats, rng: () => 0.5 });
        assert.strictEqual(none.tier, null);
        assert.strictEqual(none.reason, 'budget');
        const best = await chooseTier({ mode: 'best', kind: 'answer', budgetLeft: 1, models, stats, rng: () => 0.5 });
        assert.ok(['fast', 'smart', 'best'].includes(best.tier));
        const prior = new Map([['smart\u0000work\u0000', { successes: 40, failures: 0 }], ['fast\u0000work\u0000', { successes: 0, failures: 5 }]]);
        const learned = await chooseTier({ mode: 'balanced', kind: 'answer', budgetLeft: 1, models, stats: { forModel: async () => ({ n: 0, successRate: null, meanCostUsd: 0.0001 }) }, prior, rng: () => 0.5 });
        assert.strictEqual(learned.tier, 'smart', 'the outcomes table is the prior, not decoration');
    });

    await ok('a demoted tool is offered last, with a note, and is never removed', async () => {
        const defs = ['search_web', 'market_quote', 'read_page'].map((name) => ({ type: 'function', function: { name } }));
        const out = orderTools(defs, [
            { name: 'search_web', n: 30, successRate: 0.31 },
            { name: 'market_quote', n: 30, successRate: 0.97 },
            { name: 'read_page', n: 19, successRate: 0.1 },
        ]);
        assert.deepStrictEqual(out.tools.map((d) => d.function.name), ['market_quote', 'read_page', 'search_web']);
        assert.deepStrictEqual(out.demoted, ['search_web'], 'n < 20 is not demoted');
        assert.match(out.note, /search_web/);
        assert.strictEqual(out.tools.length, defs.length, 'never removed');
    });

    await ok('confidence grades a direct tool, one source and no evidence; a high-stakes price is challenged', async () => {
        const evidence = [
            { id: 'E1', tool: 'market_quote', text: 'BTC 110000', sources: [{ url: 'https://feed.example/btc' }] },
            { id: 'E2', tool: 'search_web', text: 'about 110000', sources: [{ url: 'https://news.example/btc' }] },
            { id: 'E3', tool: 'search_web', text: '110000', sources: [{ url: 'https://a.example/btc' }] },
            { id: 'E4', tool: 'search_web', text: '110000', sources: [{ url: 'https://b.example/btc' }] },
        ];
        const claim = (ids) => ({ claim: 'BTC is $110,000.', kind: 'live', evidence: ids, supported: ids.length > 0 });
        assert.strictEqual(grade(claim(['E1']), evidence).confidence, 'sure');
        assert.strictEqual(grade(claim(['E2']), evidence).confidence, 'likely');
        assert.strictEqual(grade(claim(['E3', 'E4']), evidence).confidence, 'sure', 'two agreeing sources');
        assert.strictEqual(grade(claim([]), evidence).confidence, 'unverified');
        assert.strictEqual(isHighStakes(claim([])), true, 'a price is high stakes');
        assert.strictEqual(isHighStakes({ claim: 'Paris is the capital of France.', kind: 'general' }), false);

        const models = fakeModels({ verdict: 'disagrees', why: 'another feed says 108,000' });
        const search = async (q) => ({ text: 'A different exchange: 108,000 USD', data: { q }, sources: [{ url: 'https://other.example/btc' }] });
        const out = await challenge({ claim: grade(claim(['E2']), evidence), evidence, task: 'What is BTC?', mode: 'balanced', models, search, now: () => Date.now() });
        assert.strictEqual(out.claim.challenge.verdict, 'disagrees');
        assert.strictEqual(out.claim.confidence, 'unsure', 'a disagreeing counter-search is not delivered as likely');
        assert.strictEqual(out.item.id, 'E5');
        assert.ok(out.cost_usd > 0, 'the read is metered');
        assert.match(unsureLine([out.claim]), /Could not confirm/);
        const none = await review({ claims: [grade(claim(['E2']), evidence)], evidence, budgetLeft: () => 0, models, search });
        assert.strictEqual(none.challenged, 0, 'no budget, no challenge');
    });

    await ok('escalation never repeats the identical call; one per step and two per task', async () => {
        assert.strictEqual(nextTier({ mode: 'balanced', current: 'smart' }), null, 'balanced has no best tier');
        assert.strictEqual(nextTier({ mode: 'best', current: 'smart' }), 'best');
        assert.strictEqual(nextTier({ mode: 'best', current: 'best' }), null);
        assert.strictEqual(nextTool({ current: 'lookup', toolNames: ['lookup', 'fetch'] }), 'fetch');
        const esc = createEscalations();
        const one = esc.plan({ stepKey: 's1', mode: 'best', currentTier: 'smart' });
        assert.strictEqual(one.kind, 'model');
        assert.notStrictEqual(one.tier, 'smart', 'never the identical call');
        assert.strictEqual(esc.plan({ stepKey: 's1', mode: 'best', currentTier: 'smart' }), null, 'one per step');
        const two = esc.plan({ stepKey: 's2', mode: 'best', currentTier: 'smart' });
        assert.ok(two, 'a second step may escalate');
        assert.strictEqual(esc.plan({ stepKey: 's3', mode: 'best', currentTier: 'smart' }), null, 'two per task');
        const tools = createEscalations();
        const t1 = tools.plan({ stepKey: 't1', mode: 'balanced', currentTier: 'smart', currentTool: 'lookup', toolNames: ['lookup', 'fetch'] });
        assert.deepStrictEqual([t1.kind, t1.tool], ['tool', 'fetch']);
        assert.notStrictEqual(t1.tool, 'lookup');
    });

    await ok('an outcome is written and deduplicated, and a correction records failures plus a suggested memory', async () => {
        const d = await testDb();
        try {
            const s = createStore(d.db);
            assert.strictEqual(await learn.record({ store: s, kind: 'answer', tier: 'smart', stepKind: 'work', tool: 'search_web', ok: true }), true);
            assert.strictEqual(await learn.record({ store: s, kind: 'answer', tier: 'smart', stepKind: 'work', tool: 'search_web', ok: true }), true);
            assert.strictEqual(await learn.record({ store: s, kind: 'answer', tier: 'smart', stepKind: 'work', tool: 'search_web', ok: false }), true);
            const row = await d.db.maybe('SELECT * FROM actor_brain_outcomes WHERE task_kind = $1', ['answer']);
            assert.deepStrictEqual([Number(row.successes), Number(row.failures), row.tool], [2, 1, 'search_web']);
            const n = await learn.recordSteps({ store: s, kind: 'answer', steps: [{ step_kind: 'work', tier: 'smart', tool: 'lookup', ok: true }, { step_kind: 'work', tier: 'smart', tool: 'lookup', ok: true }, { step_kind: 'work', tier: 'smart', tool: 'lookup', ok: false }] });
            assert.strictEqual(n, 2, 'the same outcome is one lesson');
            const parent = {
                id: s.newId('tsk'), requester: 'user:usr_01JZ0000000000000000000AAA', via: null,
                result: { brain: { kind: 'answer', tiers: ['smart'], tools: ['lookup'] }, tier: 'smart' },
            };
            await d.db.query('INSERT INTO tasks (id, requester, task, mode, budget_task, budget_day, state, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
                [parent.id, parent.requester, 'a task', 'balanced', 0.05, 0.25, 'succeeded', s.iso()]);
            const out = await learn.correction({ store: s, parent, text: 'No, that price is wrong: it is 108,000.' });
            assert.strictEqual(out.corrected, true);
            assert.ok(out.outcomes >= 2, 'a failure for the tier and the tool');
            const mem = await d.db.maybe("SELECT * FROM actor_agent_memory WHERE owner = $1 AND status = 'suggested'", [parent.requester]);
            assert.ok(mem, 'the correction is a suggested memory');
            assert.strictEqual(mem.status, 'suggested', 'never active');
            assert.match(String(mem.text), /that price is wrong/);
            assert.strictEqual(await learn.correction({ store: s, parent, text: 'And what about tomorrow?' }).then((x) => x.corrected), false, 'not every follow-up is a correction');
        } finally { await d.close(); }
    });

    await ok('a store that cannot write outcomes never fails the task', async () => {
        const bad = { db: { query: async () => { throw new Error('no table'); } }, newId: () => 'boc_x' };
        assert.strictEqual(await learn.record({ store: bad, kind: 'answer', tier: 'smart' }), false);
        assert.strictEqual((await loadPrior({ store: bad, kind: 'answer' })).size, 0);
    });

    if (results.length) { console.log(`\n${results.length} failed`); process.exit(1); }
    console.log('\nall passed');
})().catch((e) => { console.error(e); process.exit(1); });
