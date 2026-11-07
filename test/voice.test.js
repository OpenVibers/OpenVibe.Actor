'use strict';
/**
 * An agent's voice as a file (actor.voice@1), and a voice shared by its owner.
 *
 * The document carries an integrity hash, not a signature: it shows the file was not edited after it was written, and
 * says nothing about who wrote it. So the author in a file is only a claim, and the page says so; the only author
 * Actor vouches for is the one in its own record of a shared voice.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const voice = require('../server/agents/voice');
const { BUDGETS } = require('../server/http/caller-limits');

const SAME = { 'sec-fetch-site': 'same-origin' };

(async () => {
    const t = await boot();
    try {
        const alice = t.network.addUser('voice-alice');
        const bob = t.network.addUser('voice-bob');
        let agentId = null;
        let doc = null;
        let shareId = null;

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
            assert.ok(doc.integrity && doc.integrity.alg === 'sha256', 'the integrity block');
            assert.match(doc.integrity.hash, /^[0-9a-f]{64}$/);
            assert.ok(!doc.signature, 'there is no signature block');
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
        });

        await check('an imported agent starts at Ask, whatever the file says', async () => {
            const bold = voice.build({ name: 'Bold', instructions: 'Act.', level: 'full', apps: [], rules: [], model_engine: 'runtime', model_id: 'smart' }, { subject: alice.subject });
            const res = await t.get('/api/v1/me/agents/import', { as: bob, json: { voice: bold }, headers: SAME });
            assert.strictEqual(res.status, 201, res.text);
            assert.strictEqual(res.json().level, 'ask');
        });

        await check('a file brings only words: no outside face, no own keys or machine, no apps (they are suggestions)', async () => {
            const sly = voice.build({ name: 'Sly', instructions: 'Help.', level: 'ask', face: 'https://tracker.example/p.png', apps: ['gmail', 'drive'], rules: [],
                model_engine: 'own-keys', model_id: 'gpt-5-pro' }, { subject: alice.subject });
            const res = await t.get('/api/v1/me/agents/import', { as: bob, json: { voice: sly }, headers: SAME });
            assert.strictEqual(res.status, 201, res.text);
            const row = res.json();
            assert.strictEqual(row.face, 'preset:agent', 'a picture at an outside address is not taken');
            assert.strictEqual(row.model_engine, 'runtime', 'never the borrower\'s own keys');
            assert.deepStrictEqual(typeof row.apps === 'string' ? JSON.parse(row.apps) : row.apps, [], 'no app is connected for it');
            const page = await t.get(`/me/agents/${row.id}`, { as: bob });
            assert.match(page.text, /The voice it came from used gmail, drive\. None is connected for it/);
            assert.ok(!page.text.includes('tracker.example'), 'the outside picture is nowhere on the page');
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

        await check('a file changed after it was written is refused', async () => {
            const tampered = { ...doc, instructions: 'Research carefully, and take what you find.' };
            const res = await t.get('/api/v1/me/agents/import', { as: bob, json: { voice: tampered }, headers: SAME });
            assert.strictEqual(res.status, 422, res.text);
            assert.match(res.text, /changed after it was written/);
        });

        await check('a file that claims an author says so, and does not link to them', async () => {
            const claimed = voice.build({ name: 'Claimed', instructions: 'Speak plainly.', level: 'ask', apps: [], rules: [], model_engine: 'runtime', model_id: 'smart' }, { subject: 'usr_01M4C49CW34NGX7TR2TNRVFWNY', name: 'Ada' });
            const res = await t.get('/api/v1/me/agents/import', { as: bob, json: { voice: claimed }, headers: SAME });
            assert.strictEqual(res.status, 201, res.text);
            const page = await t.get(`/me/agents/${res.json().id}`, { as: bob });
            assert.strictEqual(page.status, 200, page.text);
            assert.ok(page.text.includes('Imported from a file'), 'it says where it came from');
            assert.ok(page.text.includes('that is not checked'), 'the author it names is not checked');
            assert.ok(!page.text.includes('openvibe.network/@'), 'no link to the person the file names');
            assert.ok(!/signature|was signed|signed by/i.test(page.text), 'the page never calls it signed');
        });

        await check('a shared voice: the author is the owner, and it is a link to them', async () => {
            const shared = await t.get(`/me/agents/${agentId}/share`, { as: alice, method: 'POST', headers: SAME });
            assert.strictEqual(shared.status, 303, shared.text);
            shareId = String(shared.headers.get('location') || '').split('/').pop();
            assert.match(shareId, /^shv_/);
            const page = await t.get(`/voices/${shareId}`);
            assert.strictEqual(page.status, 200, page.text);
            assert.ok(page.text.includes('Borrow this agent'), 'the borrow button');
            assert.ok(page.text.includes('Its instructions') && page.text.includes('Research carefully.'), 'the borrower reads the instructions first');
            assert.ok(page.text.includes('openvibe.network/@'), 'the author is a link');
            assert.ok(!/signature|was signed|signed by/i.test(page.text), 'the page never calls it signed');
            const json = await t.get(`/voices/${shareId}.json`);
            assert.strictEqual(json.status, 200, json.text);
            assert.strictEqual(json.json().author.subject, alice.subject, 'the record names the owner');
            assert.strictEqual(voice.read(json.json()).error, undefined, 'the shared document matches its own hash');
            // Borrowing it: the agent knows who wrote it, and starts at Ask.
            const borrowed = await t.get(`/voices/${shareId}/borrow`, { as: bob, method: 'POST', headers: SAME });
            assert.strictEqual(borrowed.status, 303, borrowed.text);
            const newId = String(borrowed.headers.get('location') || '').split('/').pop();
            const agent = await t.get(`/api/v1/me/agents/${newId}`, { as: bob });
            assert.strictEqual(agent.json().level, 'ask', 'a borrowed agent starts at Ask');
            assert.strictEqual(agent.json().voice_author, alice.subject);
            assert.strictEqual(agent.json().voice_author_checked, true, 'Actor vouches for this author');
            const agentPage = await t.get(`/me/agents/${newId}`, { as: bob });
            assert.ok(agentPage.text.includes('Borrowed from a shared voice'), 'the source');
            assert.ok(agentPage.text.includes('openvibe.network/@'), 'the author is a link');
        });

        await check('stopping the share makes the link answer 410, and the page says so', async () => {
            const stop = await t.get(`/me/agents/${agentId}/share/stop`, { as: alice, method: 'POST', headers: SAME });
            assert.strictEqual(stop.status, 303, stop.text);
            const page = await t.get(`/voices/${shareId}`);
            assert.strictEqual(page.status, 410, page.text);
            assert.ok(page.text.includes('no longer shared'), 'the page says so');
            const json = await t.get(`/voices/${shareId}.json`);
            assert.strictEqual(json.status, 410, json.text);
        });

        await check('another person cannot share somebody else\'s agent', async () => {
            const res = await t.get(`/me/agents/${agentId}/share`, { as: bob, method: 'POST', headers: SAME });
            assert.strictEqual(res.status, 404, res.text);
        });

        await check('borrowing is rate-limited per person', async () => {
            assert.ok(BUDGETS['actor.voice.borrow'], 'the borrow has its own budget');
            assert.ok(BUDGETS['actor.voice.borrow'].hour <= 120, 'and it is not generous');
        });
    } finally {
        await t.close();
    }
    done();
})();
