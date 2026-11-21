'use strict';
// How a run is worked, in agents.run@1's own fields (the owner, 11-21, under an answer's "Free AI · DeepSeek Flash":
// "did it run on the DeepSeek harness, or like where did this just API or what? And also, what mode are we in?"):
// agent.harness names the loop (openvibe: Actor's own agent; one-model; decisions; a coding harness by name) and
// where.kind says where the work happened (a coding harness: the person's machine; the rest: OpenVibe).
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const ana = t.network.addUser('harness-ana');
    const anaB = t.network.userToken(ana);
    const run = async (body, key) => {
        const r = await t.get('/api/v1/runs', { bearer: anaB, json: body, headers: { 'idempotency-key': key } });
        assert.strictEqual(r.status, 201, r.text);
        const one = await t.get(`/api/v1/runs/${r.json().id}?shape=agents.run@1`, { bearer: anaB, headers: { accept: 'application/vnd.openvibe.agents.run+json; version=1' } });
        return one.json();
    };
    try {
        await check('agent.harness and where say how and where a run is worked', async () => {
            t.providers.reset();
            t.providers.state.script = [{ content: 'Hi.' }, { content: 'Hi.' }, { content: 'Hi.' }, { content: 'Hi.' }, { content: 'Hi.' }, { content: 'Hi.' }];
            const plain = await run({ text: 'Say hi' }, 'harness-plain-0001');
            assert.deepStrictEqual([plain.agent.harness, plain.where && plain.where.kind], ['openvibe', 'openvibe'], 'Actor\'s own agent, on OpenVibe');
            const one = await run({ text: 'Say hi', engine: { kind: 'model' } }, 'harness-model-0001');
            assert.deepStrictEqual([one.agent.harness, one.where.kind], ['one-model', 'openvibe'], 'one model, on OpenVibe');
            const codex = await run({ text: 'Fix the test in my repo', engine: { kind: 'harness', harness: 'codex' } }, 'harness-codex-0001');
            assert.deepStrictEqual([codex.agent.harness, codex.where.kind], ['codex', 'machine'], 'Codex, on the person\'s machine');
        });
    } finally { await t.close(); }
    done();
})();
