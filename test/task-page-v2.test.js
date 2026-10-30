'use strict';
// The task page v2 (Actor v2, stage V2-5): the answer's citations are chips that open what the tool returned, one calm
// line says how many claims were checked and by whom, the files are cards (a chart drawn small), the plan shows each
// step done, in hand or next (and a live task has the card ready for the plan to arrive), the cost is against the
// budget with the time it took, and the plan updates never split the no-script view into one attempt each.
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const SAME = { 'sec-fetch-site': 'same-origin' };

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const bo = t.network.addUser('bo');
    t.config.loop.selfReflections = 0;
    const s = t.ctx.s;
    const { appendEvent } = require('../server/tasks/store');
    const at = (sec) => new Date(Date.now() - sec * 1000).toISOString();

    t.providers.state.script = [
        { content: 'Charting it.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'make_chart', arguments: JSON.stringify({ type: 'bar', title: 'Price -- per month', data: [{ label: 'A', value: 4.5 }, { label: 'B', value: 6.7 }] }) } }] },
        { content: 'done' },
    ];
    const created = (await t.get('/api/v1/tasks', { as: kim, json: { task: 'Compare two offers and chart them' }, headers: SAME })).json();
    await t.waitFor(created.id);
    const row = await s.db.maybe('SELECT * FROM tasks WHERE id = $1', [created.id]);
    const result = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
    result.answer = 'A is cheapest at €4.51 [E1], B is €6.74 [E2, E1]. Not a citation: `[E1]` and [E9].';
    result.evidence = [
        { id: 'E1', tool: 'read_page', input: { url: 'https://a.example/pricing' }, text: 'A · €4.51/month', sources: [{ url: 'https://a.example/pricing', title: 'A pricing' }], at: at(60) },
        { id: 'E2', tool: 'search_web', input: { query: 'b price <script>' }, text: 'B · €6.74', sources: [], at: at(50) },
        { id: 'E3', tool: 'calculate', input: { expression: '6.74-4.51' }, text: '2.23', sources: [], at: at(40) },
    ];
    result.citations = ['E1', 'E2'];
    result.checked = { by: 'deepseek:deepseek-flash', cross_family: true, reason: 'ok', claims: 4, grounded: 4 };
    result.plan = { assumptions: ['euro prices'], steps: [{ goal: 'Read both pages', state: 'done' }, { goal: 'Chart them', state: 'done' }] };
    await s.db.query('UPDATE tasks SET result = $2::jsonb, cost_usd = 0.0124, created_at = $3, finished_at = $4 WHERE id = $1', [created.id, JSON.stringify(result), at(90), at(4)]);
    const stated = ['\u2713 1. Read both pages', '\u2192 2. Chart them'].join('\n');
    await appendEvent(s, created.id, { kind: 'output', step: 'plan', agent: result.agent, text: stated, at: at(30) });
    await appendEvent(s, created.id, { kind: 'output', step: 'plan', agent: result.agent, text: stated.replace('\u2192', '\u2713'), at: at(20) });

    try {
        await check('citations become chips for the evidence the ledger has, and nothing else changes', async () => {
            const r = await t.get(`/tasks/${created.id}`, { as: kim });
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('<a class="ev" href="#ev-E1" data-ev="E1"'), 'a chip for E1');
            assert.ok(/<span class="evs"><a class="ev" href="#ev-E2"[^>]*>2<\/a><a class="ev" href="#ev-E1"[^>]*>1<\/a><\/span>/.test(r.text), '[E2, E1] is two chips, in that order');
            assert.ok(r.text.includes('<code>[E1]</code>'), 'a citation inside code stays code');
            assert.ok(r.text.includes('[E9]'), 'an id the ledger does not have stays as written');
            assert.ok(r.text.includes('aria-label="Evidence 2: Web search, b price &#60;script&#62;"'), 'the chip says what it opens, escaped');
            assert.ok(!r.text.includes('<script>"'), 'nothing from a tool input is markup');
        });

        await check('the evidence behind the chips: each item, what it was asked, what it returned, its sources', async () => {
            const r = await t.get(`/tasks/${created.id}`, { as: kim });
            assert.ok(r.text.includes('<details class="evidence" id="evidence">'), 'one fold of evidence');
            assert.ok(r.text.includes('3 items: what the tools returned, 2 cited'));
            assert.ok(r.text.includes('<li class="ev-item is-cited" id="ev-E1">') && r.text.includes('<li class="ev-item" id="ev-E3">'), 'cited and uncited marked');
            assert.ok(r.text.includes('<span class="ev-tool">Read a page</span>') && r.text.includes('https://a.example/pricing'), 'the tool by name, what it read');
            assert.ok(r.text.includes('>A pricing</a>'), 'its sources');
        });

        await check('one calm check line, files as cards, the cost against the budget and the time it took', async () => {
            const r = await t.get(`/tasks/${created.id}`, { as: kim });
            assert.ok(r.text.includes('Checked: 4 claims, 4 grounded · by DeepSeek Flash, another model family'));
            assert.ok(/<li class="file-card">[\s\S]*?<img src="[^"]+\/files\/art_[^"]+"/.test(r.text), 'the chart is drawn small on its card');
            assert.ok(r.text.includes('Price-per-month.svg'), 'its name, without the runs of dashes a title leaves');
            assert.ok(r.text.includes('<span>$0.01 of $0.05</span>') && /took 1 min 2\d s/.test(r.text), 'the cost against the budget and the time');
        });

        await check('the plan: every step and what it assumed, at the head of How it went once the task has ended', async () => {
            const r = await t.get(`/tasks/${created.id}`, { as: kim });
            const how = r.text.slice(r.text.indexOf('id="h-how"'));
            assert.ok(how.includes('<section class="plan-card" id="plan-card"'), 'the plan card is under How it went');
            assert.ok(how.includes('<li class="ps is-done"><span class="ps-mark" aria-hidden="true"></span><span class="ps-goal">Read both pages</span>'));
            assert.ok(how.includes('Assuming euro prices'));
            assert.strictEqual((r.text.match(/<section class="attempt"/g) || []).length, 1, 'plan updates do not split the no-script view into attempts');
            assert.ok(r.text.includes('<li class="tl-item tl-plan"><span class="tl-k">Plan</span><span class="tl-v">Step 2 of 2 · Chart them</span>'), 'a plan update is a step of its attempt');
        });

        await check('a live task has the plan card ready, and it shows the plan as the agent states it', async () => {
            const live = (await t.get('/api/v1/tasks', { as: kim, json: { task: 'Count to three' }, headers: SAME })).json();
            await t.waitFor(live.id);
            await s.db.query("UPDATE tasks SET state = 'running', result = NULL, finished_at = NULL WHERE id = $1", [live.id]);
            let r = await t.get(`/tasks/${live.id}`, { as: kim });
            assert.ok(/<section class="plan-card" id="plan-card" aria-labelledby="h-plan"( hidden)?>/.test(r.text), 'the card is there for js/task.js to fill');
            await appendEvent(s, live.id, { kind: 'output', step: 'plan', agent: 'openvibe-runtime', text: '\u2192 1. Count\n\u00b7 2. Say it', at: at(1) });
            r = await t.get(`/tasks/${live.id}`, { as: kim });
            const head = r.text.slice(0, r.text.indexOf('id="h-how"'));
            assert.ok(head.includes('<li class="ps is-active">') && head.includes('<li class="ps is-todo">'), 'above How it went while it runs: in hand, then next');
        });

        await check('another person still gets the 404 of a task that does not exist', async () => {
            const r = await t.get(`/tasks/${created.id}`, { as: bo });
            assert.strictEqual(r.status, 404);
            assert.ok(!r.text.includes('ev-item'));
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
