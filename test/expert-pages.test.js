'use strict';
/**
 * The Experts' pages (plan §D items 6 and 10; 2026-11-18): the gallery and an Expert's page answer anyone; the install
 * screen needs a signed-in person, shows what it may do in words, and takes one yes for all of it; an install makes the
 * person's own agent and lands on its page; a missing yes says so, in the page, keeping what was typed.
 *   node test/expert-pages.test.js
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { talks, askWords } = require('../server/http/expert-pages');

const SAME = { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1' };

(async () => {
    await check('the words: how it talks from its dials, and what it may use said plainly', async () => {
        assert.strictEqual(talks({ dials: { warmth: 2, play: 0, length: -2, edge: 1 } }), 'Very warm, brief, direct');
        assert.strictEqual(talks({ dials: { edge: 1 } }), 'Direct', 'a sentence starts with a capital');
        assert.strictEqual(talks({}), 'Even and plain');
        assert.strictEqual(askWords({ key: 'hands:ov:live.chat.post', part: 'hands', words: 'uses live: chat post (asks you first each time)', ask: true }), 'Posts in your chat (asks you first each time)');
        assert.strictEqual(askWords({ key: 'when:event:live.stream.started', part: 'when', words: 'starts when live.stream.started happens' }), 'Starts when you go live');
        assert.strictEqual(askWords({ key: 'memory:person', part: 'memory', words: 'remembers what it learns' }), 'Remembers what it learns', 'the SDK\'s words otherwise');
    });

    const t = await boot();
    try {
        await check('GET /experts: the ten, OpenVibe\'s own, signed out, with tags to narrow it', async () => {
            const r = await t.get('/experts');
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            for (const name of ['Purchase researcher', 'Compute buyer', 'Stream producer', 'Security reviewer']) assert.ok(r.text.includes(name), name);
            assert.ok(r.text.includes('href="/experts/bp_compute_buyer"'));
            const order = ['Budget coach', 'Clip finder', 'Compute buyer', 'Job researcher', 'OpenVibe builder', 'Purchase researcher', 'Security reviewer', 'Stream moderator', 'Stream producer', 'Subscription auditor'];
            const at = order.map((n) => r.text.indexOf(`<b>${n}</b>`));
            assert.deepStrictEqual([...at].sort((x, y) => x - y), at, 'OpenVibe\'s own, by name');
            assert.match(r.text, /class="ex-tag is-on" href="\/experts" aria-current="page">All</);
            const live = await t.get('/experts?tag=live');
            assert.ok(live.text.includes('Clip finder') && !live.text.includes('Budget coach'), 'a tag narrows it');
        });

        await check('GET /experts/:id: who it is, how it talks, what it never does, what it may use, Install', async () => {
            const r = await t.get('/experts/bp_stream_producer');
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('A dry, fast producer who keeps your stream on time.'));
            assert.ok(r.text.includes('Posts in your chat without your yes.'), 'what it never does');
            assert.ok(r.text.includes('Posts in your chat (asks you first each time)'), 'what it may use, in words');
            assert.ok(r.text.includes('Starts when you go live'));
            assert.ok(r.text.includes('href="/experts/bp_stream_producer/install"'));
            assert.strictEqual((await t.get('/experts/bp_nope_nope')).status, 404);
            assert.strictEqual((await t.get('/experts/not-an-id')).status, 404);
        });

        const ada = t.network.addUser('expages-ada');
        await check('install: signed out goes to sign in; signed in sees the inputs and one yes', async () => {
            const out = await t.get('/experts/bp_stream_producer/install');
            assert.strictEqual(out.status, 303);
            assert.match(out.headers.get('location'), /^\/auth\/login\?next=%2Fexperts%2Fbp_stream_producer%2Finstall$/);
            const r = await t.get('/experts/bp_stream_producer/install', { as: ada });
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.ok(r.text.includes('name="input_channel"') && r.text.includes('Your channel'));
            assert.ok(r.text.includes('name="agreed" value="all"'));
        });

        await check('install: without the yes it says so and keeps the channel; with it, the person\'s own agent', async () => {
            const no = await t.get('/experts/bp_stream_producer/install', { as: ada, method: 'POST', headers: SAME, form: { input_channel: 'ada' } });
            assert.strictEqual(no.status, 422);
            assert.ok(no.text.includes('Say yes to what it may do first.') && no.text.includes('value="ada"'));
            const yes = await t.get('/experts/bp_stream_producer/install', { as: ada, method: 'POST', headers: SAME, form: { input_channel: 'ada', agreed: 'all' } });
            assert.strictEqual(yes.status, 303, yes.text.slice(0, 400));
            assert.match(yes.headers.get('location'), /^\/me\/agents\/agt_[A-Za-z0-9]+\?installed=1$/);
            const row = await t.ctx.s.db.one("SELECT blueprint_id, version FROM agent_installs WHERE owner = $1", [`user:${ada.subject}`]);
            assert.deepStrictEqual([row.blueprint_id, Number(row.version)], ['bp_stream_producer', 1]);
            const cross = await t.get('/experts/bp_stream_producer/install', { as: ada, method: 'POST', headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }, form: { input_channel: 'ada', agreed: 'all' } });
            assert.strictEqual(cross.status, 403, 'an install comes from openvibe.actor itself');
        });
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    } finally {
        await t.close();
    }
    done();
})();
