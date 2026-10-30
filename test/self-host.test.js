'use strict';
/**
 * A self-hosted Actor (ACTOR_SELF_HOSTED=1, docs/self-host.md): it refuses to start without its owner and secrets;
 * the owner signs in with a password (a signed session cookie) and calls the API with their own token; it takes no
 * Network token; the OpenVibe runtime runs on the operator's own OpenAI-compatible model at the operator's price, and
 * with no other model family that model checks its own answers (saying so); the integrations that need a Network
 * identity (Bot, Codes, Chat) are off.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { hashPassword, checkPassword } = require('../server/auth/local');
const { startProviders } = require('./helpers/providers');

const SUBJECT = 'usr_01JZ0000000000000000000SH1';
const PASSWORD = 'correct-horse-battery-staple';
const TOKEN = `act_${'t'.repeat(43)}`;
const SECRET = 's'.repeat(43);

(async () => {
    await check('the password hash: scrypt, salted, checked in constant time', () => {
        const h = hashPassword(PASSWORD);
        assert.match(h, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
        assert.notStrictEqual(h, hashPassword(PASSWORD), 'a new salt each time');
        assert.ok(checkPassword(PASSWORD, h));
        assert.ok(!checkPassword('wrong', h) && !checkPassword(PASSWORD, 'scrypt$garbage') && !checkPassword('', h));
    });

    await check('without its owner and secrets it does not start', async () => {
        await assert.rejects(boot({ env: { ACTOR_SELF_HOSTED: '1' } }), /ACTOR_SELF_HOSTED=1 needs ACTOR_OWNER_SUBJECT.*ACTOR_OWNER_PASSWORD_HASH.*ACTOR_OWNER_TOKEN.*ACTOR_SESSION_SECRET.*npm run selfhost:init/);
    });

    const base = { ACTOR_SELF_HOSTED: '1', ACTOR_OWNER_NAME: 'kai', ACTOR_OWNER_SUBJECT: SUBJECT, ACTOR_OWNER_PASSWORD_HASH: hashPassword(PASSWORD), ACTOR_OWNER_TOKEN: TOKEN, ACTOR_SESSION_SECRET: SECRET };
    // The operator's own model: a stand-in OpenAI-compatible server of its own.
    const model = await startProviders();
    const runtimeUrl = model.env.ACTOR_DEEPSEEK_BASE_URL;
    // The stand-in providers' pinned tiers belong to those stand-ins; a self-hosted server has none, so each tier
    // resolves from the one endpoint it has (the operator's own model) — and its check is that same model.
    const t = await boot({ env: { ...base, ACTOR_RUNTIME_URL: runtimeUrl, ACTOR_RUNTIME_MODEL: 'local-model', ACTOR_DEEPSEEK_API_KEY: null, ACTOR_OPENAI_API_KEY: null, ACTOR_LOCAL_LLM_URL: null, ACTOR_LOCAL_LLM_MODEL: null, ACTOR_MODEL_FAST: null, ACTOR_MODEL_SMART: null, ACTOR_MODEL_BEST: null, ACTOR_MODEL_CHECK: null, ACTOR_MODEL_VISION: null } });

    await check('the owner signs in with the password; a wrong one is refused', async () => {
        const form = await t.get('/auth/login?next=/console');
        assert.strictEqual(form.status, 200);
        assert.match(form.text, /Sign in to your Actor/);
        assert.match(form.text, /name="next" value="\/console"/);
        const wrong = await t.get('/auth/login', { form: { password: 'nope', next: '/console' } });
        assert.strictEqual(wrong.status, 401);
        assert.ok(!wrong.headers.get('set-cookie'));
        const ok = await t.get('/auth/login', { form: { password: PASSWORD, next: '/console' } });
        assert.deepStrictEqual([ok.status, ok.headers.get('location')], [303, '/console']);
        const cookie = ok.headers.get('set-cookie').split(';')[0];
        assert.match(cookie, /^actor_local=\d{13}\.[A-Za-z0-9_-]{43}$/);
        const me = await t.get('/auth/me', { cookie });
        assert.deepStrictEqual(me.json().user, { username: 'kai', display_name: 'kai', subject_id: SUBJECT });
        const forged = await t.get('/auth/me', { cookie: `actor_local=9999999999999.${'A'.repeat(43)}` });
        assert.strictEqual(forged.json().user, null, 'a cookie not signed with the session secret is nobody');
        assert.strictEqual((await t.get('/console', { cookie })).status, 200);
    });

    await check('the API takes the owner\'s token only: never a Network token, never a wrong one', async () => {
        const kim = t.network.addUser('kim');
        assert.strictEqual((await t.get('/api/v1/tasks', { bearer: t.network.userToken(kim) })).status, 401);
        assert.strictEqual((await t.get('/api/v1/tasks', { bearer: `${TOKEN}x` })).status, 401);
        assert.strictEqual((await t.get('/api/v1/tasks', { bearer: TOKEN })).status, 200);
    });

    await check('a task runs on the operator\'s own model, checked by it (same family), at its price', async () => {
        model.reset();
        model.state.runtime = 'answer';
        const r = await t.get('/api/v1/tasks', { bearer: TOKEN, json: { task: 'Explain what a mutex is in two sentences.' } });
        assert.strictEqual(r.status, 201, r.text);
        const task = (await t.get(`/api/v1/tasks/${(await t.waitFor(r.json().id)).id}`, { bearer: TOKEN })).json();
        assert.strictEqual(task.state, 'succeeded', JSON.stringify(task.error));
        assert.deepStrictEqual([task.result.agent, task.result.model, task.result.checked.by, task.result.checked.cross_family], ['openvibe-runtime', 'stand-in', 'runtime', false], 'the model the server says it ran');
        assert.strictEqual(task.cost.usd, 0, 'a model on the operator\'s own hardware costs nothing');
        assert.strictEqual(task.requester.type, 'user');
        const calls = model.requests.filter((q) => q.path === '/deepseek/chat/completions');
        assert.ok(calls.length >= 2 && calls.every((q) => q.body.model === 'local-model'), 'the runtime and its check both went to the operator\'s model');
    });

    await check('the agent list says so; the Network-bound integrations are off', async () => {
        const agents = (await t.get('/api/v1/agents', { bearer: TOKEN })).json().agents;
        const rt = agents.find((a) => a.id === 'openvibe-runtime');
        assert.deepStrictEqual([rt.available, rt.trust, rt.model, rt.rate_card.input_usd_per_mtok, rt.rate_card.output_usd_per_mtok, rt.rate_card.source], [true, 'user-owned', 'local-model', 0, 0, runtimeUrl]);
        assert.strictEqual(agents.find((a) => a.id === 'codes').available, false);
        assert.deepStrictEqual([t.config.services.botUrl, t.config.services.codesUrl, t.config.chat.asks], ['', '', false]);
    });

    await t.close();
    await model.close();
    done();
})();
