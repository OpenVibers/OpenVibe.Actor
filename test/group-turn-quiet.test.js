'use strict';
// A group conversation's turn (Network's groups; the owner, 11-21: "Your task is done — You are Design in a group
// conversation…" in Alerts): the group shows the answer, so the run sends no done or failed alert of its own. Its done
// and failed notices are claimed when it starts; a run that is not a group's turn keeps its alerts.
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const ana = t.network.addUser('quiet-ana');
    const anaB = t.network.userToken(ana);
    const claims = async (id) => (await t.ctx.s.db.many('SELECT kind FROM actor_task_notices WHERE task_id = $1 ORDER BY kind', [id])).map((r) => r.kind);
    try {
        await check('a group turn claims its done and failed alerts at the start; any other run does not', async () => {
            t.providers.reset();
            t.providers.state.script = [{ content: 'Hello from the group.' }, { content: 'Hello from the group.' }, { content: 'Hello from the group.' }];
            const g = await t.get('/api/v1/runs', { bearer: anaB, json: { text: 'You are Design in a group conversation. Test', source: { kind: 'group', id: 'grp_test01' } }, headers: { 'idempotency-key': 'quiet-group-0001' } });
            assert.strictEqual(g.status, 201, g.text);
            assert.deepStrictEqual(await claims(g.json().id), ['failed', 'succeeded'], 'claimed, so never sent');
            const plain = await t.get('/api/v1/runs', { bearer: anaB, json: { text: 'Say hello' }, headers: { 'idempotency-key': 'quiet-plain-0001' } });
            assert.strictEqual(plain.status, 201, plain.text);
            assert.deepStrictEqual(await claims(plain.json().id), [], 'an ordinary run keeps its alerts');
            const odd = await t.get('/api/v1/runs', { bearer: anaB, json: { text: 'Say hi', source: { kind: 'group', id: '../../etc' } }, headers: { 'idempotency-key': 'quiet-odd-0001' } });
            assert.strictEqual(odd.status, 201, odd.text);
            assert.deepStrictEqual(await claims(odd.json().id), [], 'a source that is not a group id is ignored');
        });
    } finally { await t.close(); }
    done();
})();
