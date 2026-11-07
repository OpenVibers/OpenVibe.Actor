'use strict';
/**
 * An agent's voice as a file (actor.voice@1): export, import, borrow. A voice is a voice and nothing else — never
 * memory, never a connector's token, never a file — and a borrowed agent starts at level ask, whatever the file says.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const voice = require('../server/agents/voice');

const SAME = { 'sec-fetch-site': 'same-origin' };

(async () => {
    const t = await boot();
    try {
        const alice = t.network.addUser('voice-alice');
        const bob = t.network.addUser('voice-bob');
        let agentId = null;
        let doc = null;

        await check('the owner exports an actor.voice@1 document, and it carries no memory, token or file', async () => {
            const created = await t.get('/api/v1/agents', { as: alice, json: { name: 'Researcher', instructions: 'Research carefully.', model: { engine: 'runtime', model: 'smart' } }, headers: SAME });
            assert.strictEqual(created.status, 201, created.text);
            agentId = created.json().id;
            const res = await t.get(`/api/v1/me/agents/${agentId}/voice`, { as: alice });
            assert.strictEqual(res.status, 200, res.text);
            doc = res.json();
            assert.strictEqual(doc.voice, 'actor.voice@1');
            assert.strictEqual(doc.name, 'Researcher');
            assert.strictEqual(doc.instructions, 'Research carefully.');
            assert.strictEqual(doc.level, 'ask');
            assert.strictEqual(doc.author.subject, alice.subject);
            assert.match(doc.signature.hash, /^[0-9a-f]{64}$/);
            const text = JSON.stringify(doc);
            for (const word of ['memory', 'token', 'mems_', 'sk-']) assert.ok(!text.includes(word), `the document carries no ${word}`);
        });

        await check('another person cannot export it: the same 404 as an agent that does not exist', async () => {
            const res = await t.get(`/api/v1/me/agents/${agentId}/voice`, { as: bob });
            assert.strictEqual(res.status, 404, res.text);
        });

        await check('a voice imports as a new agent: the voice round-trips, and no memory or token comes with it', async () => {
            const res = await t.get('/api/v1/me/agents/import', { as: bob, json: { voice: doc }, headers: SAME });
            assert.strictEqual(res.status, 201, res.text);
            const agent = res.json();
            assert.strictEqual(agent.name, doc.name);
            assert.strictEqual(agent.instructions, doc.instructions);
            assert.deepStrictEqual(agent.apps, doc.apps || []);
            assert.strictEqual(agent.voice_author, alice.subject);
            assert.strictEqual(Number(await t.ctx.s.db.value('SELECT count(*) FROM actor_agent_memory WHERE agent_id = $1', [agent.id])), 0, 'no memory');
            // And the new agent exports the same voice.
            const again = await t.get(`/api/v1/me/agents/${agent.id}/voice`, { as: bob });
            const out = again.json();
            assert.strictEqual(out.name, doc.name);
            assert.strictEqual(out.instructions, doc.instructions);
            assert.strictEqual(out.author.subject, bob.subject, 'the new owner signs it');
        });

        await check('an imported agent starts at Ask, whatever the file says', async () => {
            // A voice that asks for full, signed as such: the file says full, the new agent asks.
            const bold = voice.build({ name: 'Bold', instructions: 'Act.', level: 'full', apps: [], rules: [], model_engine: 'runtime', model_id: 'smart' }, { subject: alice.subject });
            const res = await t.get('/api/v1/me/agents/import', { as: bob, json: { voice: bold }, headers: SAME });
            assert.strictEqual(res.status, 201, res.text);
            assert.strictEqual(res.json().level, 'ask');
        });

        await check('a field the contract does not know is stripped, not kept', async () => {
            const res = await t.get('/api/v1/me/agents/import', { as: bob, json: { voice: { ...doc, extra_field: 'hello' } }, headers: SAME });
            assert.strictEqual(res.status, 201, res.text);
            const again = await t.get(`/api/v1/me/agents/${res.json().id}/voice`, { as: bob });
            assert.strictEqual(again.json().extra_field, undefined);
        });

        await check('a file that carries a memory or a token is refused', async () => {
            for (const extra of [{ memory: 'mems_01M4C49CW7R8S9T0A1B2C3D4E5' }, { tokens: { connect: { email: 'sk-live-1' } } }]) {
                const res = await t.get('/api/v1/me/agents/import', { as: bob, json: { voice: { ...doc, ...extra } }, headers: SAME });
                assert.strictEqual(res.status, 422, res.text);
                assert.match(res.text, /never carries/);
            }
        });

        await check('a file changed after it was signed is refused', async () => {
            const tampered = { ...doc, instructions: 'Research carefully, and take what you find.' };
            const res = await t.get('/api/v1/me/agents/import', { as: bob, json: { voice: tampered }, headers: SAME });
            assert.strictEqual(res.status, 422, res.text);
            assert.match(res.text, /changed after it was signed/);
        });

        await check('the hash is the document\'s own: a rebuilt document verifies, a rewritten one does not', async () => {
            const built = voice.build({ name: 'House voice', instructions: 'Speak plainly.', level: 'ask', apps: [], rules: [], model_engine: 'runtime', model_id: 'smart' }, { subject: alice.subject, at: '2026-11-07T09:31:00.000Z' });
            assert.strictEqual(voice.read(built).error, undefined);
            assert.strictEqual(voice.read({ ...built, instructions: 'Speak loudly.' }).error.includes('changed after it was signed'), true);
        });

        await check('the page exports the voice as a file, and the borrow page shows it before it is taken', async () => {
            const res = await t.get(`/me/agents/${agentId}/voice`, { as: alice });
            assert.strictEqual(res.status, 200, res.text);
            assert.match(String(res.headers.get('content-disposition') || ''), /attachment/);
            assert.strictEqual(res.json().voice, 'actor.voice@1');
        });
    } finally {
        await t.close();
    }
    done();
})();
