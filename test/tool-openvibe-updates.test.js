'use strict';
// openvibe_updates: OpenVibe's own news, from the network's changelog, newest first, within the days asked.
const assert = require('assert');
const updates = require('../server/runtime/tools/openvibe_updates');
const { check, done } = require('./helpers/boot');

const NOW = Date.parse('2026-11-15T08:00:00Z');
const entry = (service, plain, at, kind = 'better') => ({ service, plain, subject: `${plain} (#1)`, kind, deployed_at: at, major: false, pr_url: `https://github.com/OpenVibers/OpenVibe.${service}/pull/1` });
const ENTRIES = [
    entry('live', 'Go live: Front, Back and every lens switch the camera', '2026-11-14T20:00:00Z', 'fix'),
    entry('chat', 'DMs take files', '2026-11-15T06:00:00Z', 'new'),
    entry('games', 'No text arrows on the portal', '2026-11-12T10:00:00Z'),
    entry('live', 'A change from last month', '2026-10-01T10:00:00Z'),
];

function ctxWith(answer) {
    const asked = [];
    const fetch = async (url) => { asked.push(String(url)); const a = answer(String(url)); return { ok: a.status === 200, status: a.status, text: async () => JSON.stringify(a.body) }; };
    // A fresh config object each time: the service helper keeps one client per config.
    return { asked, ctx: { config: { networkInternalUrl: 'http://127.0.0.1:4000', services: {}, oauth: {} }, fetch, now: () => NOW, log: { warn() {}, info() {} } } };
}

(async () => {
    await check('the week\'s changes, newest first, with their site, kind and link', async () => {
        const { asked, ctx } = ctxWith(() => ({ status: 200, body: { entries: ENTRIES } }));
        const out = await updates.run({}, ctx);
        assert.strictEqual(asked[0], 'http://127.0.0.1:4000/api/v1/changelog?limit=200');
        assert.strictEqual(out.data.days, 7);
        assert.deepStrictEqual(out.data.entries.map((x) => x.what), ['DMs take files', 'Go live: Front, Back and every lens switch the camera', 'No text arrows on the portal']);
        assert.deepStrictEqual(out.data.entries.map((x) => x.kind), ['New', 'Fixed', 'Better']);
        assert.deepStrictEqual(out.data.by_site, { chat: 1, live: 1, games: 1 });
        assert.ok(out.data.entries[0].link.startsWith('https://'));
        assert.strictEqual(out.sources[0].url, 'https://openvibe.network/updates');
    });

    await check('one site, in its short name or its domain', async () => {
        const { asked, ctx } = ctxWith(() => ({ status: 200, body: { entries: ENTRIES.filter((e) => e.service === 'live') } }));
        const out = await updates.run({ site: 'openvibe.live', days: 60 }, ctx);
        assert.strictEqual(asked[0], 'http://127.0.0.1:4000/api/v1/changelog?limit=200&service=live');
        assert.strictEqual(out.data.days, 30, 'thirty days at most');
        assert.strictEqual(out.data.count, 1);
    });

    await check('a changelog that does not answer is words the model can act on', async () => {
        const { ctx } = ctxWith(() => ({ status: 503, body: {} }));
        const out = await updates.run({}, ctx);
        assert.match(out.data.error, /answered 503/);
    });

    await check('it reads, it never acts, and it is offered when Network is configured', async () => {
        assert.strictEqual(updates.acts, false);
        assert.strictEqual(updates.scope, 'public');
        assert.ok(updates.available({ config: { networkUrl: 'https://openvibe.network' } }));
        assert.match(updates.description, /what's new/i);
    });
    done();
})();
