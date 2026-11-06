'use strict';
// "Runs on: my computer" (plan L55 C3; the owner, 11-01: "a remote session, or a local agent session"): a person
// chooses where their tasks run, beside the model they chose. On their computer, every model call of the agent loop
// goes to the model on their own computer (OpenVibe.AI's node credential, whatever key they chose above it), and a
// coding task is pinned to Codes on their machine. Private mode and a public chat's ask stay on OpenVibe.
//   node test/runs-on.test.js
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { createModels } = require('../server/runtime/models');
const prefs = require('../server/runtime/model-prefs');

const SAME = { 'sec-fetch-site': 'same-origin' };
const quiet = { log() {}, warn() {}, error() {}, info() {} };
const reply = (status, obj) => ({ ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj) });

/** Models that reach a fake OpenVibe.AI, and record every call. */
function aiModels(calls) {
    const config = {
        models: { tiers: {}, providerOrder: ['openai'], listTimeoutMs: 200 },
        providers: { openai: { apiKey: 'sk-fixture-operator-key', baseUrl: 'https://api.openai.test/v1', model: 'gpt-5-mini' } },
        ai: { url: 'https://ai.openvibe.services', audience: 'openvibe.ai', scope: 'ai.run.create', clientId: 'actor', clientSecret: 'actor-secret', timeoutMs: 5000 },
        networkInternalUrl: 'https://network.test', networkUrl: 'https://openvibe.network',
        oauth: { clientId: 'actor', clientSecret: 'actor-secret' },
    };
    const fetchImpl = async (url, opts = {}) => {
        const u = String(url);
        if (u.includes('/oauth/token')) return reply(200, { access_token: 'tok_service_token', token_type: 'Bearer', expires_in: 300, scope: 'ai.run.create' });
        calls.push({ url: u, headers: opts.headers || {} });
        if (u.endsWith('/models')) return reply(200, { data: [{ id: 'gpt-5-mini' }] });
        // The answer's check asks for a verdict as JSON; the run itself gets the answer.
        const checking = String(opts.body || '').includes('\\"claims\\"');
        const content = checking ? JSON.stringify({ claims: [{ claim: 'Two plus two is four.', kind: 'general', evidence: [], supported: true }], ok: true, reason: 'general knowledge' }) : 'Four.';
        return reply(200, { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], model: 'llama3', usage: { prompt_tokens: 4, completion_tokens: 1 }, x_openvibe: { cost_usd: 0 } });
    };
    return createModels({ config, fetchImpl, log: quiet });
}

(async () => {
    const calls = [];
    const seenChoices = [];
    const models = aiModels(calls);
    // The loop, reduced to one model call: what matters here is which model the run's calls go to.
    const loop = {
        run: async ({ task }) => { seenChoices.push(models.currentChoice()); const r = await models.chat({ tier: 'smart', messages: [{ role: 'user', content: task }] }); return { text: r.text, state: {} }; },
        close: async () => {}, planText: () => '', escalate: async () => null, revise: async () => null,
    };
    const t = await boot({ models, loop });
    const kim = t.network.addUser('runs-kim');
    try {
        await check('the default is OpenVibe, and the API sets it alone without touching the model choice', async () => {
            const before = await t.get('/api/v1/me/model', { as: kim });
            assert.strictEqual(before.json().runs_on, 'openvibe');
            await t.get('/api/v1/me/model', { as: kim, method: 'PUT', json: { choice: 'own:openai' }, headers: SAME });
            const put = await t.get('/api/v1/me/model', { as: kim, method: 'PUT', json: { runs_on: 'computer' }, headers: SAME });
            assert.strictEqual(put.status, 200, put.text);
            assert.deepStrictEqual([put.json().runs_on, put.json().choice], ['computer', 'own:openai'], 'the model choice is kept');
            const bad = await t.get('/api/v1/me/model', { as: kim, method: 'PUT', json: { runs_on: 'the-moon' }, headers: SAME });
            assert.strictEqual(bad.status, 422);
            assert.strictEqual((await t.get('/api/v1/me/model', { as: kim })).json().runs_on, 'computer', 'the bad one never landed');
            // A choice change keeps where it runs.
            await t.get('/api/v1/me/model', { as: kim, method: 'PUT', json: { choice: 'auto' }, headers: SAME });
            assert.strictEqual((await t.get('/api/v1/me/model', { as: kim })).json().runs_on, 'computer');
        });

        await check('on their computer, the run\'s model calls go to the model on their own computer', async () => {
            calls.length = 0;
            const made = await t.get('/api/v1/tasks', { as: kim, json: { task: 'What is two plus two?' }, headers: SAME });
            assert.strictEqual(made.status, 201, made.text);
            const row = await t.waitFor(made.json().id);
            assert.strictEqual(row.state, 'succeeded', JSON.stringify([row.error_code, row.error_detail]));
            const loopCalls = calls.filter((c) => c.url.endsWith('/chat/completions'));
            assert.ok(loopCalls.length >= 1, 'the loop called a model');
            assert.ok(loopCalls.every((c) => c.headers['x-openvibe-credential'] === `node:${kim.subject || kim.id}`), JSON.stringify(loopCalls.map((c) => c.headers['x-openvibe-credential'])));
            const why = JSON.stringify(row.explanation);
            assert.ok(why.includes('on the model on your computer'), 'the explanation says where it ran');
        });

        await check('back on OpenVibe, the same person\'s run uses the model they chose (auto: no call to AI)', async () => {
            await t.get('/api/v1/me/model', { as: kim, method: 'PUT', json: { runs_on: 'openvibe' }, headers: SAME });
            calls.length = 0;
            const made = await t.get('/api/v1/tasks', { as: kim, json: { task: 'What is two plus two?' }, headers: SAME });
            const row = await t.waitFor(made.json().id);
            assert.strictEqual(row.state, 'succeeded', JSON.stringify([row.error_code, row.error_detail]));
            assert.ok(calls.every((c) => !c.headers['x-openvibe-credential']), 'no person credential');
            // The AI layer (ACTOR_AI_ROUTER) needs the person on every call even with no key chosen: on_behalf_of.
            assert.strictEqual(seenChoices[seenChoices.length - 1].subject, kim.subject || kim.id, 'the run names its person for the router');
        });

        await check('private mode stays on OpenVibe\'s own open model even when it is set to the computer', async () => {
            await t.get('/api/v1/me/model', { as: kim, method: 'PUT', json: { runs_on: 'computer' }, headers: SAME });
            calls.length = 0;
            const made = await t.get('/api/v1/tasks', { as: kim, json: { task: 'What is two plus two?', mode: 'private' }, headers: SAME });
            await t.waitFor(made.json().id);
            assert.ok(calls.every((c) => !String(c.headers['x-openvibe-credential'] || '').startsWith('node:')), 'never their computer');
            await t.get('/api/v1/me/model', { as: kim, method: 'PUT', json: { runs_on: 'openvibe' }, headers: SAME });
        });

        await check('/chat/model: the "Where it runs" form saves from openvibe.actor only', async () => {
            const page = await t.get('/chat/model', { as: kim });
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('id="runs-on"'));
            assert.ok(page.text.includes('name="runs_on" value="openvibe" checked'));
            assert.ok(page.text.includes('https://ai.openvibe.services/you?allow=actor&amp;provider=node'), 'set up the computer\'s model at OpenVibe.AI');
            assert.ok(page.text.includes('https://openvibe.bot/machines'), 'add the machine for coding');
            const saved = await t.get('/chat/runs-on', { as: kim, form: { runs_on: 'computer' }, headers: SAME });
            assert.strictEqual(saved.status, 303);
            assert.strictEqual(saved.headers.get('location'), '/chat/model?saved=runs#runs-on');
            const after = await t.get('/chat/model?saved=runs', { as: kim });
            assert.ok(after.text.includes('name="runs_on" value="computer" checked'));
            assert.ok(after.text.includes('Your next task runs on your computer.'));
            const cross = await t.get('/chat/runs-on', { as: kim, form: { runs_on: 'openvibe' }, headers: { 'sec-fetch-site': 'cross-site' } });
            assert.strictEqual(cross.status, 403);
            const bad = await t.get('/chat/runs-on', { as: kim, form: { runs_on: 'nope' }, headers: SAME });
            assert.match(bad.headers.get('location'), /^\/chat\/model\?error=/);
            assert.strictEqual((await t.get('/api/v1/me/model', { as: kim })).json().runs_on, 'computer');
            const anon = await t.get('/chat/runs-on', { form: { runs_on: 'computer' }, headers: SAME });
            assert.strictEqual(anon.status, 303);
            assert.match(anon.headers.get('location'), /^\/auth\/login/);
        });

        await check('the choice "Runs on: my computer" means: AI\'s node credential, for a person only', async () => {
            assert.deepStrictEqual(prefs.computerChoice('user:usr_1'), { subject: 'usr_1', provider: 'node', model: null });
            assert.strictEqual(prefs.computerChoice('ip:1.2.3.4'), null);
            assert.deepStrictEqual(prefs.RUNS_ON, ['openvibe', 'computer']);
            assert.deepStrictEqual(prefs.wire(null).runs_on, 'openvibe');
        });
    } finally { await t.close(); }
    done();
})();
