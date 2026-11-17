'use strict';
/**
 * An answer's receipt (agents.step@1 1.3.0; plan §AD.17, "one agent system that always finds a way": every answer says
 * how it ran). Every model call of a turn notes the rung that paid for it (models.js noteReceipt: OpenVibe's allowance,
 * the person's own key, their computer); the engine writes one 'receipt' event when the turn ends (receiptOf); the
 * conversation's steps put it on the turn's answer as cost (with BY) and model. Bad shapes never pass.
 *   node test/answer-receipt.test.js
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { receiptOf } = require('../server/tasks/engine');
const { receiptStep } = require('../server/http/runs-api');

(async () => {
    await check('receiptOf: totals, the spend by rung, and the model that wrote the answer', async () => {
        const r = receiptOf([
            { rung: 'allowance', provider: 'deepseek', model: 'deepseek-chat', tokens: 4100, usd: 0, ms: 9800 },
            { rung: 'key', provider: 'anthropic', model: 'claude-sonnet-5-5', tokens: 2020, usd: 0.0042, ms: 11600 },
            { rung: 'exchange', tokens: 99, usd: 9, ms: 1 },
        ]);
        assert.deepStrictEqual(r, {
            cost: { usd: 0.0042, tokens: 6120, seconds: 21.4, by: { allowance: { tokens: 4100, usd: 0, seconds: 9.8 }, key: { tokens: 2020, usd: 0.0042, seconds: 11.6 } } },
            model: { id: 'claude-sonnet-5-5', provider: 'anthropic' },
        });
        assert.deepStrictEqual(receiptOf([{ rung: 'machine', provider: 'machine', model: '', tokens: 0, usd: 0, ms: 4000 }]).cost.by, { machine: { tokens: 0, usd: 0, seconds: 4 } });
    });

    await check('receiptStep: the contract\'s shape only', async () => {
        assert.strictEqual(receiptStep(null), null);
        assert.strictEqual(receiptStep({ cost: { by: { exchange: { usd: 1 } } } }), null, 'no known rung, no receipt');
        assert.deepStrictEqual(receiptStep({ cost: { usd: 0.5, tokens: 12.6, seconds: 2, by: { key: { usd: 0.5, tokens: 12.6, seconds: 2, extra: 1 }, exchange: {} } }, model: { id: ' m-1 ', provider: 'Bad Provider' } }),
            { cost: { usd: 0.5, tokens: 13, seconds: 2, by: { key: { usd: 0.5, tokens: 13, seconds: 2 } } }, model: { id: 'm-1' } });
    });

    const t = await boot();
    const kim = t.network.addUser('kim');
    const kimB = t.network.userToken(kim);
    try {
        await check('a conversation\'s answer carries its receipt: what it took, what paid, the model', async () => {
            t.providers.reset();
            t.providers.state.script = [{ content: 'Three rentals under $0.40 an hour.' }, { content: 'Three rentals under $0.40 an hour.' }, { content: 'Three rentals under $0.40 an hour.' }];
            const r = await t.get('/api/v1/runs', { bearer: kimB, json: { text: 'Find me three cheap GPU rentals' }, headers: { 'idempotency-key': 'receipt-start-0001' } });
            assert.strictEqual(r.status, 201, r.text);
            const runId = r.json().id;
            await t.waitFor(runId);
            const steps = (await t.get(`/api/v1/runs/${runId}/steps?conversation=1`, { bearer: kimB })).json().steps;
            const answers = steps.filter((x) => x.kind === 'message' && x.from === 'agent');
            assert.ok(answers.length, JSON.stringify(steps.map((x) => [x.kind, x.from])));
            const last = answers[answers.length - 1];
            assert.ok(last.cost && last.cost.by && last.cost.by.allowance, `the answer has its receipt: ${JSON.stringify(last.cost)}`);
            assert.ok(last.model && typeof last.model.id === 'string' && last.model.id, `and its model: ${JSON.stringify(last.model)}`);
            assert.ok(Number.isInteger(last.cost.tokens) && last.cost.tokens >= 0);
            const others = steps.filter((x) => x !== last && x.cost && x.cost.by);
            assert.deepStrictEqual(others, [], 'only the answer carries it');
            // The contract, when the installed openvibe-contracts knows step 1.3.0.
            let contracts = null;
            try { contracts = require('openvibe-contracts'); } catch { contracts = null; }
            const knows = contracts && typeof contracts.validate === 'function' && contracts.validate('agents.step@1', { run_id: 'x', seq: 1, kind: 'message', text: 'x', model: { id: 'm' }, started_at: '2026-11-17T00:00:00Z', ended_at: null, cost: null, child_run: null }).valid;
            if (knows) assert.deepStrictEqual(contracts.validate('agents.step@1', last).errors, []);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
