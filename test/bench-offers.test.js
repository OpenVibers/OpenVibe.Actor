'use strict';
/**
 * Tasks as Bench cases (Actor v2, stage V2-10), with consent: the confirmation page shows exactly the task and the
 * final answer (never evidence, files, memory or trace), nothing is stored until it is confirmed, the answer passes
 * noLooks(), the offer is listed on the person's tasks page, and it is withdrawable by its owner only.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const SAME = { 'sec-fetch-site': 'same-origin' };
const EVIDENCE = 'EVIDENCE_SENTINEL_7f3a';
const ARTIFACT = 'ARTIFACT_SENTINEL_9c1b.png';

async function finishedTask(t, user, text) {
    t.providers.state.script = [{ content: 'The answer is **4** [E1].' }];
    const created = await t.get('/api/v1/tasks', { as: user, json: { task: text }, headers: SAME });
    assert.strictEqual(created.status, 201, created.text);
    const row = await t.waitFor(created.json().id);
    assert.strictEqual(row.state, 'succeeded', row.error_detail);
    return row.id;
}

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const bo = t.network.addUser('bo');
    t.config.loop.selfReflections = 0;
    const s = t.ctx.s;

    try {
        const text = 'What does the fixture say the price is?';
        const id = await finishedTask(t, kim, text);
        const row = await s.db.maybe('SELECT * FROM tasks WHERE id = $1', [id]);
        const result = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
        result.answer = 'The price is 4 EUR. A shirtless man at the stall said so.';
        result.evidence = [{ id: 'E1', tool: 'read_page', input: { url: 'https://example.org' }, text: EVIDENCE }];
        result.artifacts = [{ name: ARTIFACT, url: `/tasks/${id}/files/art_sentinel`, mime: 'image/png', size: 10 }];
        result.plan = { assumptions: [], steps: [{ goal: 'Read the fixture', state: 'done' }] };
        await s.db.query('UPDATE tasks SET result = $2::jsonb WHERE id = $1', [id, JSON.stringify(result)]);
        await s.db.query(
            `INSERT INTO actor_spans (id, task_id, kind, name, started_at, ms, cost_usd, ok, step) VALUES ($1, $2, 'model', 'sentinel-model', $3, 10, 0.001, true, 1)`,
            [s.newId('spn'), id, s.iso()],
        );

        await check('the preview shows the task and the final answer, and nothing else that is private', async () => {
            const page = await t.get(`/tasks/${id}/offer-bench`, { as: kim });
            assert.strictEqual(page.status, 200, page.text);
            assert.ok(page.text.includes(text), 'the task, as asked');
            assert.ok(page.text.includes('The price is 4 EUR'), 'the answer');
            assert.ok(page.text.includes('streamer at the stall said so'), 'the answer as written');
            assert.ok(page.text.includes('shirtless'), 'describing a person is fine before it can be offered');
            assert.ok(!page.text.includes(EVIDENCE), 'no evidence');
            assert.ok(!page.text.includes(ARTIFACT), 'no file');
            assert.ok(!page.text.includes('sentinel-model'), 'no trace');
            assert.ok(page.text.includes('Confirm and offer'), 'the person confirms');
            const count = await s.db.value('SELECT count(*)::int FROM actor_bench_offers WHERE task_id = $1', [id]);
            assert.strictEqual(count, 0, 'opening the preview offers nothing');
        });

        await check('only the owner may open or make the offer: another person gets 404', async () => {
            assert.strictEqual((await t.get(`/tasks/${id}/offer-bench`, { as: bo })).status, 404);
            assert.strictEqual((await t.get(`/tasks/${id}/offer-bench`, { as: bo, method: 'POST', headers: SAME })).status, 404);
            assert.strictEqual(await s.db.value('SELECT count(*)::int FROM actor_bench_offers WHERE task_id = $1', [id]), 0);
        });

        await check('confirming stores the task and the answer only, and the task page says it is offered', async () => {
            const res = await t.get(`/tasks/${id}/offer-bench`, { as: kim, method: 'POST', headers: SAME });
            assert.strictEqual(res.status, 303);
            assert.strictEqual(res.headers.get('location'), `/tasks/${id}#bench`);
            const offer = await s.db.maybe('SELECT * FROM actor_bench_offers WHERE task_id = $1', [id]);
            assert.ok(offer, 'the offer is stored');
            assert.strictEqual(offer.owner, `user:${kim.subject}`);
            assert.strictEqual(offer.text, text);
            assert.ok(offer.answer.includes('streamer at the stall said so'));
            assert.ok(offer.answer.includes('shirtless'), 'the stored answer is as written');
            assert.strictEqual(offer.status, 'offered');
            assert.ok(Date.parse(offer.offered_at));
            const page = await t.get(`/tasks/${id}`, { as: kim });
            assert.ok(page.text.includes('Offered as a Bench case.'));
            assert.ok(page.text.includes('Withdraw the offer'));
        });

        await check('the person\'s tasks page lists the offer', async () => {
            const page = await t.get('/tasks', { as: kim });
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('Offered as Bench cases'));
            assert.ok(page.text.includes(text));
            const other = await t.get('/tasks', { as: bo });
            assert.ok(!other.text.includes('Offered as Bench cases'), 'not on someone else\'s page');
        });

        await check('withdraw deletes it, and the task offers it again', async () => {
            const res = await t.get(`/tasks/${id}/bench-offer/withdraw`, { as: kim, method: 'POST', headers: SAME });
            assert.strictEqual(res.status, 303);
            assert.strictEqual(await s.db.value('SELECT count(*)::int FROM actor_bench_offers WHERE task_id = $1', [id]), 0, 'the offer is deleted');
            const page = await t.get(`/tasks/${id}`, { as: kim });
            assert.ok(page.text.includes('Offer as a Bench case'));
            assert.ok(!page.text.includes('Offered as a Bench case.'));
            assert.ok(!(await t.get('/tasks', { as: kim })).text.includes('Offered as Bench cases'));
            // A second person's withdrawal is a 404 and never deletes someone else's offer.
            await s.db.query("INSERT INTO actor_bench_offers (task_id, owner, text, answer, offered_at, status) VALUES ($1, $2, $3, $4, $5, 'offered')", [id, `user:${kim.subject}`, text, 'answer', s.iso()]);
            assert.strictEqual((await t.get(`/tasks/${id}/bench-offer/withdraw`, { as: bo, method: 'POST', headers: SAME })).status, 404);
            assert.strictEqual(await s.db.value('SELECT count(*)::int FROM actor_bench_offers WHERE task_id = $1', [id]), 1);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
