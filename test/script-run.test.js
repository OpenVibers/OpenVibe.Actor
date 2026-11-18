'use strict';
/**
 * script_run (plan §AD.26 item 6, heavy scripts on Run): the packages list (exact versions only), the bundle (files and
 * folders only, ustar, kept per list), the job body (no network, 1.1.0 plain, 1.2.0 with packages, minutes and memory
 * clamped), and the tool's answers (a value, a failed program with its stderr, refusals before anything is sent).
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { parse, pack, createScriptPackages } = require('../server/runtime/script-packages');
const { createSkillRun, scriptBody, SCRIPT_WALL_MAX } = require('../server/skills/run');
const tool = require('../server/runtime/tools/script_run');

const PRJ = 'prj_01JABCDEFGHJKMNPQRSTVWXYZ0';
const USR = 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0';
const MED = 'med_01JABCDEFGHJKMNPQRSTVWXYZ0';
let failed = 0;
async function check(name, fn) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err && err.stack}`); }
}

/** The entries of a gzipped ustar: [type, path, size]. */
function entriesOf(gz) {
    const tar = zlib.gunzipSync(gz);
    const out = [];
    for (let at = 0; at + 512 <= tar.length;) {
        const h = tar.subarray(at, at + 512);
        if (h.every((b) => b === 0)) break;
        const f = (o, n) => { const b = h.subarray(o, o + n); const z = b.indexOf(0); return b.subarray(0, z < 0 ? n : z).toString(); };
        assert.strictEqual(f(257, 5), 'ustar');
        const sum = h.reduce((a, b, i) => a + (i >= 148 && i < 156 ? 32 : b), 0);
        assert.strictEqual(parseInt(f(148, 8), 8), sum, 'a valid checksum');
        const size = parseInt(f(124, 12), 8);
        const prefix = f(345, 155);
        out.push([String.fromCharCode(h[156]), (prefix ? `${prefix}/` : '') + f(0, 100), size]);
        at += 512 + Math.ceil(size / 512) * 512;
    }
    return out;
}

function fakeRun(job) {
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
        const call = { url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null };
        calls.push(call);
        const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
        if (call.method === 'POST' && /\/api\/v1\/jobs$/.test(call.url)) return json(201, { job: { ...job, state: 'queued' } });
        if (call.method === 'GET') return json(200, job);
        return json(200, {});
    };
    const clock = { t: 0 };
    const run = createSkillRun({
        config: { services: { runUrl: 'https://run.test', linkUrl: 'https://openvibe.link' }, skills: { placementWaitMs: 5000 }, oauth: { clientId: 'actor', clientSecret: 's' }, networkInternalUrl: 'http://127.0.0.1:4000' },
        fetchImpl, tokens: { authHeaders: async () => ({ Authorization: 'Bearer t' }), invalidate() {} },
        projects: { forSubject: async () => [{ project_id: PRJ, archived: false }] },
        now: () => clock.t, sleep: async () => { clock.t += 100; }, pollMs: 1,
    });
    return { run, calls };
}

(async () => {
    console.log('script-run: heavy scripts on Run');

    await check('packages: exact versions only, ten at most, each once, sorted into one key', async () => {
        const a = parse(['lodash@4.17.21', '@scope/pkg@1.2.3']);
        assert.deepStrictEqual(a.specs, ['@scope/pkg@1.2.3', 'lodash@4.17.21']);
        assert.strictEqual(a.key, parse(['@scope/pkg@1.2.3', 'lodash@4.17.21']).key, 'the same list, the same key');
        for (const bad of [['lodash@^4.17.0'], ['lodash@latest'], ['lodash'], ['lodash@4'], ['https://evil.example/x.tgz'], ['git+ssh://x@1.0.0'], ['../x@1.0.0'], ['Lodash@1.0.0'], ['a@1.0.0', 'a@1.0.1']]) {
            assert.ok(parse(bad).error, `${JSON.stringify(bad)} is refused`);
        }
        assert.ok(parse(Array.from({ length: 11 }, (_, i) => `p${i}@1.0.0`)).error, 'eleven is too many');
        assert.deepStrictEqual(parse(undefined), { specs: [], key: null });
    });

    await check('the bundle: a ustar of files and folders only, links left out, long paths in the prefix', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-test-'));
        try {
            const deep = path.join(dir, 'pkg', 'd'.repeat(90), 'e'.repeat(40));
            fs.mkdirSync(deep, { recursive: true });
            fs.writeFileSync(path.join(dir, 'pkg', 'index.js'), 'module.exports = 1;');
            fs.writeFileSync(path.join(deep, 'x.js'), 'module.exports = 2;');
            fs.mkdirSync(path.join(dir, '.bin'));
            fs.symlinkSync('../pkg/index.js', path.join(dir, '.bin', 'pkg'));
            const list = entriesOf(pack(dir));
            assert.deepStrictEqual(list.map(([t]) => t).filter((t) => t !== '0' && t !== '5'), [], 'files and folders only');
            assert.ok(list.some(([t, p]) => t === '0' && p === 'pkg/index.js'));
            assert.ok(list.some(([t, p]) => t === '0' && p === `pkg/${'d'.repeat(90)}/${'e'.repeat(40)}/x.js`), 'a long path survives');
            assert.ok(!list.some(([, p]) => p.startsWith('.bin/pkg')), 'the link is left out');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    await check('bundle(): installed once per list, stored private in Media, kept, and shared by calls at once', async () => {
        let installs = 0;
        const stored = [];
        const media = { enabled: true, putBytes: async (bytes, o) => { stored.push(o); return { id: MED, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }; } };
        const install = async (dir, specs) => {
            installs++;
            fs.mkdirSync(path.join(dir, 'node_modules', 'tiny'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'node_modules', 'tiny', 'index.js'), `module.exports = ${JSON.stringify(specs)};`);
            return { ok: true };
        };
        const b = createScriptPackages({ media, install });
        const [x, y] = await Promise.all([b.bundle(['tiny@1.0.0']), b.bundle(['tiny@1.0.0'])]);
        assert.deepStrictEqual([x.media_id, x.specs], [MED, ['tiny@1.0.0']]);
        assert.strictEqual(x.sha256, y.sha256);
        await b.bundle(['tiny@1.0.0']);
        assert.strictEqual(installs, 1, 'once per list');
        assert.strictEqual(stored[0].mimeType, 'application/gzip');
        const failing = createScriptPackages({ media, install: async () => ({ ok: false, error: 'npm could not install them: 404 Not Found' }), log: {} });
        assert.match((await failing.bundle(['nope@9.9.9'])).error, /404/);
        assert.match((await createScriptPackages({ media: null }).bundle(['tiny@1.0.0'])).error, /Media is not connected/);
    });

    await check('the job: inline code and its sha256, no network, 1.1.0 plain and 1.2.0 with packages, minutes clamped', async () => {
        const plain = scriptBody({ code: 'x', input: { a: 1 }, minutes: 30 });
        assert.deepStrictEqual(plain.artifact, { name: 'openvibe-skill-runner', version: '1.1.0' });
        assert.strictEqual(plain.args.sha256, crypto.createHash('sha256').update('x').digest('hex'));
        assert.deepStrictEqual([plain.egress, plain.requirements.resources.egress, plain.inputs], ['none', 'none', undefined]);
        assert.strictEqual(plain.limits.wall_ms, SCRIPT_WALL_MAX, 'ten minutes at most');
        assert.ok(!('modules' in plain.args));
        const pk = scriptBody({ code: 'x', input: {}, minutes: 1, packages: { media_id: MED, sha256: 'a'.repeat(64) } });
        assert.deepStrictEqual(pk.artifact, { name: 'openvibe-skill-runner', version: '1.2.0' });
        assert.deepStrictEqual([pk.args.modules, pk.inputs], ['packages.tgz', [{ name: 'packages.tgz', media_id: MED, sha256: 'a'.repeat(64) }]]);
        assert.strictEqual(pk.limits.wall_ms, 60_000);
        assert.strictEqual(pk.ttl_ms, 60_000 + 120_000);
        assert.deepStrictEqual(pk.requirements.trust, ['user-owned', 'first-party'], 'the person\'s own machines, then OpenVibe\'s pool');
    });

    await check('the tool: a value back; a failed program with its stderr; refusals before anything is sent', async () => {
        const ok = fakeRun({ id: 'job_01JABCDEFGHJKMNPQRSTVWXYZ0', state: 'succeeded', usage: { wall_ms: 4200 }, result: { ok: true, output: { mean: 3 }, exit: 0 } });
        const ctx = { requester: `user:${USR}`, skillRun: ok.run, media: null, signal: null };
        let r = await tool.run({ code: 'process.stdout.write("{}")', input: [1, 2, 3, 4, 5] }, ctx);
        assert.ok(!r.isError, r.text);
        assert.deepStrictEqual(JSON.parse(r.text).output, { mean: 3 });
        const sent = ok.calls.find((c) => c.method === 'POST' && /\/jobs$/.test(c.url)).body;
        assert.deepStrictEqual(sent.args.input, [1, 2, 3, 4, 5]);
        assert.strictEqual(sent.egress, 'none');

        const bad = fakeRun({ id: 'job_01JABCDEFGHJKMNPQRSTVWXYZ1', state: 'succeeded', result: { ok: false, error: 'the tool exited with 1', exit: 1, stderr: 'TypeError: x is not a function' } });
        r = await tool.run({ code: 'x()' }, { ...ctx, skillRun: bad.run });
        assert.ok(r.isError);
        assert.match(JSON.parse(r.text).stderr, /TypeError/);

        const none = fakeRun({});
        const quiet = { ...ctx, skillRun: none.run };
        assert.ok((await tool.run({ code: 'x', input: 'y'.repeat(1024 * 1024 + 10) }, quiet)).isError, 'over 1 MB of input');
        assert.match((await tool.run({ code: 'x', packages: ['lodash@^4'] }, { ...quiet, media: { enabled: true, putBytes: async () => ({}) } })).text, /exact version/);
        assert.match((await tool.run({ code: 'x', packages: ['lodash@4.17.21'] }, quiet)).text, /Media is not connected/);
        assert.match((await tool.run({ code: 'x' }, { ...quiet, requester: 'agent:x' })).text, /signed-in person/);
        assert.match((await tool.run({ code: '   ' }, quiet)).text, /give the program/);
        assert.strictEqual(none.calls.length, 0, 'nothing was sent to Run');
    });

    console.log(failed ? `\n${failed} failed` : '\nall passed');
    process.exit(failed ? 1 : 0);
})();
