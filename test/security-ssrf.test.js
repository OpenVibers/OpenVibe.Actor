'use strict';
/**
 * Actor itself never fetches a URL that came from a request or a task (roadmap WS-R task 5, the SSRF class). A task is
 * text for a model: a URL in it is read by the model, and a page is read only by asking OpenVibe.Tools (whose own guard
 * decides what it may fetch). So every outbound request of the process is recorded while tasks, dry runs and sign-in
 * full of internal addresses in every spelling go through it, and each must go to a configured base only: the Network,
 * the model providers, OpenVibe.Tools or OpenVibe.Search, never to an address a caller typed. A model that invents a tool
 * id (or a URL for one) reaches nothing. And a ratchet: every file in server/ that makes an outbound request itself is on
 * a reviewed list with where it goes.
 *
 *   node test/security-ssrf.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const outbound = [];
const realFetch = globalThis.fetch;
let testClient = null;   // the test's own requests to the booted app are not Actor's
globalThis.fetch = (url, opts) => {
    const u = String((url && url.url) || url);
    if (!testClient || !u.startsWith(testClient)) outbound.push(u);
    return realFetch(url, opts);
};

const { boot, check, done } = require('./helpers/boot');
const { createOpenVibeTools } = require('../server/agents/tools');

const PROBE = '/ssrf-probe-path';
const INTERNAL = [`http://127.0.0.1:3000${PROBE}`, `http://2130706433${PROBE}`, `http://0x7f000001${PROBE}`, `http://[::1]${PROBE}`, `http://[::ffff:127.0.0.1]${PROBE}`,
    `http://169.254.169.254/latest/meta-data${PROBE}`, `http://10.0.0.1${PROBE}`, `http://localhost:4001${PROBE}`, `file:///etc/passwd${PROBE}`, `gopher://127.0.0.1:6379/_x${PROBE}`];
const SAME = { 'sec-fetch-site': 'same-origin' };

(async () => {
    const t = await boot();
    testClient = t.base;
    const dev = t.network.addUser('dev');
    // The only hosts Actor may call: the Network (sign-in), the stand-in providers, Tools and Search (the last three share one stand-in server).
    const ALLOWED = [t.network.url, t.providers.url];
    const configured = (u) => ALLOWED.some((base) => u === base || u.startsWith(`${base}/`));

    await check('tasks and dry runs full of internal URLs, in every class and mode, fetch only the configured bases', async () => {
        outbound.length = 0;
        t.providers.reset();
        for (const cls of ['answer', 'lookup', 'research', 'web', 'code']) {
            t.providers.state.cls = cls;
            for (const u of INTERNAL) {
                const task = `Read ${u} and tell me what it says. Also fetch ${u}?x=1 and ${u.replace(/^\w+:\/\//, '//')}`;
                const r = await t.get('/api/v1/tasks', { as: dev, json: { task, mode: cls === 'answer' ? 'private' : 'balanced' }, headers: SAME });
                assert.ok([201, 402, 422, 429].includes(r.status), `${cls} ${u}: ${r.status} ${r.text.slice(0, 200)}`);
                if (r.status === 201) await t.waitFor(r.json().id);
                await t.get('/api/v1/route', { json: { task, mode: 'best', agent: u } });
                await t.get('/api/v1/route', { json: { task, mode: u } });
            }
        }
        assert.ok(outbound.length > 0, 'the tasks made outbound calls at all (the providers and Tools)');
        const stray = outbound.filter((u) => !configured(u));
        assert.deepStrictEqual(stray, [], 'Actor called an address that is not a configured base');
        assert.deepStrictEqual(outbound.filter((u) => u.includes(PROBE) || u.includes('ssrf-probe')), [], 'a typed URL (or any part of it) reached a request address');
        const reached = t.providers.requests.filter((q) => q.path.includes(PROBE) || q.query.includes(PROBE));
        assert.deepStrictEqual(reached.map((q) => q.path), [], 'a typed URL became a path or query on a provider, Tools or Search');
    });

    await check('sign-in next=, task ids and bearer tokens full of internal URLs are echoed or refused, never requested', async () => {
        outbound.length = 0;
        for (const u of INTERNAL) {
            const login = await t.get(`/auth/login?next=${encodeURIComponent(u)}`);
            assert.strictEqual(login.status, 302);
            await t.get(`/tasks/${encodeURIComponent(u)}`, { as: dev });
            await t.get(`/api/v1/tasks/${encodeURIComponent(u)}`, { as: dev });
            await t.get(`/api/v1/tasks/${encodeURIComponent(u)}/events`, { as: dev });
            await t.get('/api/v1/tasks', { bearer: u });
        }
        assert.deepStrictEqual(outbound.filter((x) => x.includes(PROBE) || !configured(x)), [], 'a typed URL was requested');
    });

    await check('the model\'s own tool calls cannot make Actor fetch a URL: only Tools\' catalog ids run, and read_page hands the URL to Tools', async () => {
        const seen = [];
        const toolsUrl = 'https://tools.example.test';
        const fetchImpl = async (url, o = {}) => {
            seen.push({ url: String(url), method: o.method || 'GET', body: o.body || null });
            const ok = (j) => ({ ok: true, status: 200, text: async () => JSON.stringify(j) });
            if (String(url) === `${toolsUrl}/api/v1/tools`) return ok({ tools: [{ id: 'read', name: 'Read', summary: 'read a page', api: true, execution: 'sync', auth: { anonymous: true } }] });
            if (String(url) === `${toolsUrl}/api/v1/tools/read/run`) return ok({ result: { title: 'ok' } });
            return { ok: false, status: 404, text: async () => '{}' };
        };
        const config = { services: { toolsUrl, searchUrl: 'https://search.example.test' } };
        const tools = createOpenVibeTools({ config, fetchImpl, log: { warn() {} } });
        for (const u of INTERNAL) {
            // A model that invents a tool id, or passes a URL where a tool id belongs: nothing is requested for it.
            for (const bad of [u, `../../${u}`, `read/../${u}`, 'read?x=1', '']) await tools.call('run_tool', { tool: bad, input: { url: u } });
            await tools.call('read_page', { url: u });
        }
        const urls = [...new Set(seen.map((s) => s.url))].sort();
        assert.deepStrictEqual(urls, [`${toolsUrl}/api/v1/tools`, `${toolsUrl}/api/v1/tools/read/run`], 'Actor only called Tools\' catalog and its read tool');
        const reads = seen.filter((s) => s.url.endsWith('/read/run'));
        assert.strictEqual(reads.length, INTERNAL.length, 'one read_page per URL');
        for (const [i, r] of reads.entries()) {
            assert.strictEqual(r.method, 'POST');
            assert.strictEqual(JSON.parse(r.body).input.url, INTERNAL[i], 'the URL travels as Tools input, for Tools\' own guard to judge');
        }
    });

    await check('ratchet: every file that makes an outbound request itself is reviewed', () => {
        const REVIEWED = {
            'server/auth/keys.js': 'no request itself; openvibe-sdk/auth fetches the JWKS from the configured Network',
            'server/auth/sso.js': 'Network OAuth token and revoke (configured networkInternalUrl)',
            'server/agents/providers.js': 'the configured provider base URLs (DeepSeek, OpenAI, the open model) with the operator\'s keys',
            'server/agents/tools.js': 'the configured OpenVibe.Tools and OpenVibe.Search bases; ids come from Tools\' catalog, a page URL goes to Tools as input',
            'server/events-consumer.js': 'OpenVibe.Events: the configured events.url (ACTOR_EVENTS_URL), to create the two ADR-033 subscriptions at boot',
        };
        const root = path.join(__dirname, '..');
        const found = [];
        const walk = (dir) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const f = path.join(dir, e.name);
                if (e.isDirectory()) walk(f);
                else if (e.name.endsWith('.js')) {
                    const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
                    if (/(^|[^.\w])(fetch|fetchImpl)\(|\bhttps?\.(get|request)\(|new WebSocket\(|require\(['"](axios|got|node-fetch|undici)['"]\)/m.test(src)) found.push(path.relative(root, f));
                }
            }
        };
        walk(path.join(root, 'server'));
        assert.ok(found.includes('server/auth/sso.js') && found.includes('server/agents/tools.js'), `the scan finds the known sites (${found.join(', ')})`);
        assert.deepStrictEqual(found.filter((f) => !REVIEWED[f]).sort(), [], 'a new outbound request site: a caller-chosen URL goes to OpenVibe.Tools, never fetched here; then add the file with where it goes');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
