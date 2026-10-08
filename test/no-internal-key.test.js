'use strict';
/**
 * No X-Internal-Key anywhere (ADR-014: "No developer-facing path ever accepts X-Internal-Key").
 * Code, client scripts, deploy files, the environment template and the manifest must not
 * mention it; the running Actor never sends it to Network (the Network mock refuses any request
 * that carries one), and a request that presents one gets no special treatment.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');

const ROOT = path.join(__dirname, '..');
const PATTERN = /x-internal-key|internal[_-]?key|INTERNAL_API_KEY/i;

function files(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...files(p)); else out.push(p);
    }
    return out;
}

(async () => {
    await check('no mention in server/, public/, deploy/, docs/*.json, .env.example, package.json or CI', async () => {
        const targets = [
            ...files(path.join(ROOT, 'server')), ...files(path.join(ROOT, 'public')), ...files(path.join(ROOT, 'deploy')),
            ...(fs.existsSync(path.join(ROOT, 'docs')) ? files(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.json')) : []),
            path.join(ROOT, '.env.example'), path.join(ROOT, 'package.json'), path.join(ROOT, '.github', 'workflows', 'ci.yml'),
        ].filter((f) => fs.existsSync(f));
        assert.ok(targets.length > 20);
        const hits = targets.filter((f) => PATTERN.test(fs.readFileSync(f, 'utf8')));
        assert.deepStrictEqual(hits.map((f) => path.relative(ROOT, f)), []);
    });

    const t = await boot();
    await check('a whole session (sign-in, every page, the router) never sends an internal key to Network', async () => {
        const u = t.network.addUser('nia');
        for (const p of ['/', '/agents', '/docs', '/tasks', '/updates', '/auth/me']) await t.get(p, { as: u });
        await t.get('/api/v1/route', { as: u, json: { task: 'write a haiku' } });
        const sent = t.network.requests.filter((r) => r.headers['x-internal-key']);
        assert.strictEqual(sent.length, 0);
    });

    await check('presenting X-Internal-Key changes nothing: the public routes answer as for anyone', async () => {
        const r = await t.get('/api/v1/agents', { headers: { 'x-internal-key': 'anything' } });
        assert.strictEqual(r.status, 200);
        const me = await t.get('/auth/me', { headers: { 'x-internal-key': 'anything' } });
        assert.deepStrictEqual(JSON.parse(me.text), { user: null }, 'the key signs nobody in');
    });

    await t.close();
    done();
})();
