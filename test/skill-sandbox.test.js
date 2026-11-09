'use strict';
/**
 * HO8 step 3 (ADR-060): skills that run code, sandboxed.
 *
 * The document (@2), the code scan (each rule on a sample that trips it, and a clean tool that passes), the cross-field
 * checks, publishing to Media, the skill.run kind and its exact target, args validation, the Run job's exact body and
 * delegation headers, no node, the result as data cut to 64 KiB, and the card's words.
 */
const assert = require('assert');
const crypto = require('crypto');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const document = require('../server/skills/document');
const scan = require('../server/skills/scan');
const skills = require('../server/skills');
const toolModule = require('../server/skills/tools');
const args = require('../server/skills/args');
const kinds = require('../server/agents/kinds');
const allows = require('../server/agents/allows');
const { createSkillRun, jobBody } = require('../server/skills/run');
const { createRegistry } = require('../server/runtime/tools');

const SAME = { 'sec-fetch-site': 'same-origin' };
const PRJ = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const MED = 'med_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const JOB = 'job_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

const CLEAN = "'use strict';\nlet raw = '';\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', (chunk) => { raw += chunk; });\nprocess.stdin.on('end', () => {\n  const input = JSON.parse(raw);\n  const slug = String(input.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');\n  process.stdout.write(JSON.stringify({ slug }));\n});\n";

/** A sandbox document for the tests. `code` and `tools` may be overridden to trip one rule. */
function sandbox(over = {}) {
    const tool = {
        name: 'slugify', description: 'Turn a title into a URL slug, with no network.',
        language: 'javascript', entry: 'slugify.js', net: 'deny',
        args: { type: 'object', properties: { title: { type: 'string', maxLength: 120 } }, required: ['title'], additionalProperties: false },
        ...(over.tool || {}),
    };
    return document.build({
        slug: over.slug || 'slugify-a-title',
        name: over.name || 'Slugify a title',
        description: over.description || 'Use when a title needs a URL slug.',
        version: over.version || '1.0.0',
        instructions: over.instructions || 'Call the slugify tool with the title.',
        runs: 'sandbox',
        resources: over.resources || [{ path: 'slugify.js', media_type: 'text/javascript', text: over.code || CLEAN }],
        tools: over.tools || [tool],
        requires: over.requires || { kinds: ['skill.run'] },
        ...(over.license ? { license: over.license } : {}),
    });
}

/** A Media stand-in: it stores exactly what it was given and answers an id and the sha256 of those bytes. */
function fakeMedia() {
    const stored = [];
    return {
        stored,
        async put(text, { name } = {}) {
            const bytes = Buffer.from(String(text), 'utf8');
            stored.push({ name, text: String(text), bytes });
            return { id: MED, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
        },
    };
}

/** A Run stand-in: every call is recorded, and the answer is the job the test wants. */
function fakeRun({ job = null, submitStatus = null, read = null } = {}) {
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
        const call = { url: String(url), method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null };
        calls.push(call);
        const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
        if (call.method === 'POST' && /\/api\/v1\/jobs$/.test(call.url)) {
            if (submitStatus) return json(submitStatus.status, submitStatus.body);
            return json(201, { job });
        }
        if (call.method === 'POST' && /\/cancel$/.test(call.url)) return json(200, { ...(job || {}), state: 'cancelled' });
        if (call.method === 'GET' && /\/api\/v1\/jobs\/[^/]+$/.test(call.url)) return json(200, read ? read(call) : job);
        return json(404, { detail: 'not found' });
    };
    return { calls, fetchImpl };
}

function runOf(fetchImpl, { waitMs = 1000, clock = { t: 0 } } = {}) {
    return createSkillRun({
        config: { services: { runUrl: 'https://run.test', linkUrl: 'https://openvibe.link' }, skills: { placementWaitMs: waitMs, ttlMs: 120000 }, oauth: { clientId: 'actor', clientSecret: 's' }, networkInternalUrl: 'http://network.test' },
        fetchImpl,
        tokens: { authHeaders: async () => ({ Authorization: 'Bearer actor-token' }), invalidate() {} },
        projects: { forSubject: async () => [{ project_id: PRJ, role: 'owner', archived: false }] },
        now: () => clock.t, sleep: async () => { clock.t += 500; },
        pollMs: 1,
    });
}

(async () => {
    // ── The document ──────────────────────────────────────────────────────────────────────────────────────
    await check('actor.skill@2 reads, validates and hashes as the contract says; code and net are in the hash', async () => {
        const doc = sandbox();
        assert.strictEqual(doc.skill, 'actor.skill@2');
        assert.deepStrictEqual(contracts.validate('actor.skill@2', doc).errors, []);
        assert.strictEqual(document.read(doc).error, undefined, 'it reads back');
        assert.ok(document.canonical(doc).indexOf('"tools"') < document.canonical(doc).indexOf('"requires"'), 'tools come before requires in the canonical JSON');
        assert.notStrictEqual(document.hashOf({ ...doc, resources: [{ ...doc.resources[0], text: `${CLEAN}\n// edited` }] }), doc.integrity.hash, 'editing the code changes the hash');
        assert.notStrictEqual(document.hashOf({ ...doc, tools: [{ ...doc.tools[0], net: 'public' }] }), doc.integrity.hash, 'widening the network changes the hash');
        assert.ok(document.read({ ...doc, resources: [{ ...doc.resources[0], text: `${CLEAN}\n// edited` }] }).error, 'an edited document does not match its own hash');
        // A @2 prompt-only document is valid too (the contract's own fixture shape), but Actor publishes prompts as @1.
        const prompt = document.build({ slug: 'a-prompt', name: 'A prompt', description: 'When.', version: '1.0.0', instructions: 'Do it.' });
        assert.strictEqual(prompt.skill, 'actor.skill@1');
    });

    await check('the cross-field checks: every entry is a resource, every code resource is an entry, tool names are unique', async () => {
        const doc = sandbox();
        assert.strictEqual(document.crossField(doc), null);
        assert.match(document.read({ ...doc, tools: [{ ...doc.tools[0], entry: 'missing.js' }], integrity: { alg: 'sha256', hash: '0'.repeat(64) } }).error, /not one of the skill's resources/);
        assert.match(document.read({ ...doc, resources: [...doc.resources, { path: 'other.js', media_type: 'text/javascript', text: CLEAN }], integrity: { alg: 'sha256', hash: '0'.repeat(64) } }).error, /not the entry of any tool/);
        const two = { ...doc.tools[0] };
        assert.match(document.read({ ...doc, tools: [doc.tools[0], two], integrity: { alg: 'sha256', hash: '0'.repeat(64) } }).error, /used twice/);
        // A prompt skill carries no tools and no code.
        const promptWithTools = { ...document.build({ slug: 'p', name: 'P', description: 'When.', version: '1.0.0', instructions: 'Go.' }), tools: [doc.tools[0]] };
        assert.ok(document.read(promptWithTools).error, 'a @1 skill carries no tools');
    });

    // ── The code scan ────────────────────────────────────────────────────────────────────────────────────
    await check('the code scan: every code rule fails or flags its sample, and a clean tool passes', async () => {
        const cases = [
            ['code.env', 'block', 'process.env.HOME'],
            ['code.process', 'block', "require('child_process').spawn('ls')"],
            ['code.process', 'block', "require('node:child_process').spawn('ls')"],
            ['code.dynamic', 'block', "eval('1 + 1')"],
            ['code.vm', 'block', "require('vm').runInNewContext('1')"],
            ['code.worker', 'block', "require('worker_threads').Worker"],
            ['code.worker', 'block', "require('node:worker_threads').Worker"],
            ['code.fs_write', 'block', "require('fs').writeFileSync('/tmp/x', 'y')"],
            ['code.fs_write', 'block', "require('fs').promises.writeFile('/tmp/x', 'y')"],
            ['code.require', 'block', "require('http')"],
            ['code.require', 'block', "createRequire(import.meta.url)('http')"],
            ['code.encoded', 'block', `const blob = '${Buffer.from("eval('1 + 1')" + ' '.repeat(220)).toString('base64')}';`],
            ['code.minified', 'block', `const x = '${'a'.repeat(2100)}';`],
            ['code.network', 'block', "fetch('https://openvibe.tools/api')"],
            ['code.network', 'block', "require('node:https').get('https://openvibe.tools')"],
        ];
        for (const [rule, severity, code] of cases) {
            const doc = sandbox({ code });
            const out = scan.scan(doc);
            const f = out.findings.find((x) => x.rule === rule);
            assert.ok(f, `${rule}: the sample is found (found ${out.findings.map((x) => x.rule).join(', ')})`);
            assert.strictEqual(f.severity, severity, `${rule}: ${severity}`);
            assert.strictEqual(f.tool, 'slugify', `${rule}: the finding names the tool`);
            assert.strictEqual(out.state, severity === 'block' ? 'failed' : 'flagged', `${rule}: the state follows the severity`);
        }
        const clean = scan.scan(sandbox());
        assert.strictEqual(clean.state, 'passed', `a clean tool passes (${JSON.stringify(clean.findings)})`);
        assert.deepStrictEqual(clean.findings, []);
        // Code is read as code, never as a script resource: no resource.code finding for a sandbox .js resource.
        assert.ok(!scan.scan(sandbox()).findings.some((f) => f.rule === 'resource.code'));
    });

    await check('the network rules never allow more than the tool declared', async () => {
        const openvibe = scan.scan(sandbox({ tool: { net: 'openvibe-only' }, code: "fetch('https://openvibe.tools/api')" }));
        assert.strictEqual(openvibe.state, 'flagged', 'OpenVibe sites only is flagged, not blocked');
        assert.ok(openvibe.findings.some((f) => f.rule === 'code.network' && f.severity === 'warn'));
        const foreign = scan.scan(sandbox({ tool: { net: 'openvibe-only' }, code: "fetch('https://evil.example/x')" }));
        assert.strictEqual(foreign.state, 'failed', 'a non-OpenVibe host under openvibe-only fails');
        const dynamicHost = scan.scan(sandbox({ tool: { net: 'openvibe-only' }, code: 'fetch(someUrl)' }));
        assert.strictEqual(dynamicHost.state, 'failed', 'a host the registry cannot read under openvibe-only fails');
        const publicNet = scan.scan(sandbox({ tool: { net: 'public' }, code: "fetch('https://example.com')" }));
        assert.strictEqual(publicNet.state, 'flagged', 'the internet is flagged');
        assert.ok(publicNet.findings.some((f) => f.rule === 'code.network' && f.severity === 'warn'));
    });

    await check('the scan flags timers over 5 s and big loops over input, and does not flag smaller ones', async () => {
        const timer = scan.scan(sandbox({ code: 'setTimeout(() => {}, 6000);' }));
        assert.strictEqual(timer.state, 'flagged');
        assert.ok(timer.findings.some((f) => f.rule === 'code.timer' && f.tool === 'slugify'));
        assert.strictEqual(scan.scan(sandbox({ code: 'setTimeout(() => {}, 1000);' })).state, 'passed');
        const loop = scan.scan(sandbox({ code: 'for (const item of input.items) { process.stdout.write(item); }' }));
        assert.strictEqual(loop.state, 'flagged');
        assert.ok(loop.findings.some((f) => f.rule === 'code.loop'));
    });

    // ── Publishing to Media ──────────────────────────────────────────────────────────────────────────────
    const t = await boot();
    try {
        const alice = t.network.addUser('sandbox-alice');
        const agent = await t.get('/api/v1/agents', { as: alice, json: { name: 'A sandbox helper', instructions: 'Help me.' }, headers: SAME });
        assert.strictEqual(agent.status, 201, agent.text);
        const agentId = agent.json().id;
        let listing = null;

        await check('publishing stores the exact scanned bytes in Media and pins { media_id, sha256 } on an @2 listing', async () => {
            const media = fakeMedia();
            const doc = sandbox();
            const out = await skills.publish(t.ctx.s, { doc, publisher: { kind: 'person', subject: alice.subject, name: alice.username }, media });
            assert.strictEqual(out.error, undefined, out.error);
            listing = out.listing;
            assert.strictEqual(listing.listing, 'actor.skill-listing@2');
            assert.deepStrictEqual(contracts.validate('actor.skill-listing@2', listing).errors, []);
            assert.deepStrictEqual(listing.code, [{ name: 'slugify.js', media_id: MED, sha256: sha(CLEAN) }]);
            assert.strictEqual(listing.skill.integrity.hash, document.hashOf(listing.skill), 'the listing keeps the document as published');
            assert.strictEqual(media.stored.length, 1);
            assert.strictEqual(media.stored[0].bytes.toString('utf8'), CLEAN, 'the bytes stored are the code resource');
            assert.strictEqual(sha(media.stored[0].bytes.toString('utf8')), listing.code[0].sha256, 'the pinned sha256 is the stored bytes');
            const row = await t.ctx.s.db.maybe('SELECT code FROM actor_skill_listings WHERE id = $1', [listing.id]);
            assert.deepStrictEqual(document.parse(row.code), listing.code, 'the pins are kept with the listing');
        });

        await check('a sandbox skill installs on an agent, and its tools are offered with the doc, schema and net in words', async () => {
            const res = await t.get(`/api/v1/me/agents/${agentId}/skills`, { as: alice, json: { listing_id: listing.id }, headers: SAME });
            assert.strictEqual(res.status, 201, res.text);
            const tools = await toolModule.toolsFor(t.ctx.s, { owner: `user:${alice.subject}`, agentId });
            assert.strictEqual(tools.definitions.length, 1);
            const def = tools.definitions[0];
            assert.ok(def.function.description.includes('Turn a title into a URL slug'));
            assert.ok(def.function.description.includes('no internet'));
            assert.deepStrictEqual(def.function.parameters, listing.skill.tools[0].args);
            const runtime = tools.byAlias.get(def.function.name);
            const step = runtime.step({ title: 'Hello There' });
            assert.strictEqual(step.kind, 'skill.run');
            assert.strictEqual(step.target, 'slugify-a-title@1.0.0 slugify');
            assert.strictEqual(step.act, 'act');
            assert.ok(kinds.isKind(step.kind) && kinds.allowable(step.kind));
            assert.strictEqual(kinds.label(step.kind), 'running a skill\'s code in a sandbox');
            assert.ok(allows.matches([{ kind: 'skill.run', target: 'slugify-a-title@1.0.0 slugify' }], 'skill.run', step.target), 'always allow covers exactly this version tool');
            assert.ok(!allows.matches([{ kind: 'skill.run', target: 'slugify-a-title@1.0.1 slugify' }], 'skill.run', step.target), 'a new version asks again');
        });

        await check('args are validated against the tool\'s schema before anything is submitted', async () => {
            const schema = listing.skill.tools[0].args;
            assert.strictEqual(args.validate(schema, { title: 'A title' }).ok, true);
            assert.match(args.validate(schema, {}).error, /needs "title"/);
            assert.match(args.validate(schema, { title: 'x', extra: 1 }).error, /does not take "extra"/);
            assert.match(args.validate(schema, { title: 3 }).error, /must be a string/);
            assert.match(args.validate(schema, { title: 'x'.repeat(121) }).error, /longer than 120/);
            let called = 0;
            const tools = await toolModule.toolsFor(t.ctx.s, { owner: `user:${alice.subject}`, agentId, run: { execute: async () => { called++; return { ok: true }; } } });
            const runtime = tools.byAlias.get(tools.definitions[0].function.name);
            const out = await runtime.run({ title: 9 }, { store: t.ctx.s });
            assert.ok(out.isError, 'a bad call is an error');
            assert.strictEqual(called, 0, 'nothing was submitted');
        });

        await check('the card and install page say it runs code in a sandbox, with each tool\'s net and the scan findings per tool', async () => {
            const page = await t.get('/skills/slugify-a-title', { as: alice });
            assert.strictEqual(page.status, 200, page.text);
            assert.ok(page.text.includes('<h2>Its code</h2>') && page.text.includes('It runs in a sandbox on a machine of yours'), 'the sandbox words, once');
            assert.ok(page.text.includes('no internet'), 'the net in plain words');
            assert.ok(page.text.includes('slugify'), 'the tool is listed');
            const list = await t.get('/skills');
            assert.ok(list.text.includes('Runs code in a sandbox'), 'the card says it too, as a chip');
        });

        await check('a flagged code skill asks first and a failed one never installs', async () => {
            const flaggedMedia = fakeMedia();
            const flaggedDoc = sandbox({ slug: 'a-networked-skill', name: 'A networked skill', tool: { net: 'public' }, code: "fetch('https://example.com/x')" });
            const flagged = await skills.publish(t.ctx.s, { doc: flaggedDoc, publisher: { kind: 'person', subject: alice.subject }, media: flaggedMedia });
            assert.strictEqual(flagged.listing.scan.state, 'flagged');
            assert.ok(flagged.listing.scan.findings.some((f) => f.tool === 'slugify'), 'the finding names the tool');
            const page = await t.get('/skills/a-networked-skill', { as: alice });
            assert.ok(page.text.includes('the internet'));
            assert.ok(page.text.includes('I read the findings above'), 'a flagged code skill asks the person to read');
            const refused = await t.get(`/api/v1/me/agents/${agentId}/skills`, { as: alice, json: { listing_id: flagged.listing.id }, headers: SAME });
            assert.strictEqual(refused.status, 422, 'it does not install on a tap');
            const read = await t.get(`/api/v1/me/agents/${agentId}/skills`, { as: alice, json: { listing_id: flagged.listing.id, read_findings: true }, headers: SAME });
            assert.strictEqual(read.status, 201, 'it installs after the person read the findings');

            const failedDoc = sandbox({ slug: 'a-failed-code-skill', name: 'A failed code skill', code: 'process.env.HOME' });
            const failed = await skills.publish(t.ctx.s, { doc: failedDoc, publisher: { kind: 'person', subject: alice.subject }, media: fakeMedia() });
            assert.strictEqual(failed.listing.scan.state, 'failed');
            const failedPage = await t.get('/skills/a-failed-code-skill', { as: alice });
            assert.ok(!failedPage.text.includes('Install this skill'), 'a failed skill has no install button');
            const never = await t.get(`/api/v1/me/agents/${agentId}/skills`, { as: alice, json: { listing_id: failed.listing.id, read_findings: true }, headers: SAME });
            assert.strictEqual(never.status, 422, 'a failed skill never installs');
        });

        // ── The tool result is data ─────────────────────────────────────────────────────────────────────
        await check('the tool\'s JSON returns as an untrusted tool result, with the job id, wall time and exit, cut to 64 KiB', async () => {
            const run = { execute: async () => ({ ok: true, job_id: JOB, wall_ms: 456, exit: 0, result: { ok: true, output: { slug: 'a-title' }, exit: 0 } }) };
            const tools = await toolModule.toolsFor(t.ctx.s, { owner: `user:${alice.subject}`, agentId, run });
            const runtime = tools.byAlias.get(toolModule.aliasOf('slugify-a-title', 'slugify'));
            const out = await runtime.run({ title: 'A title' }, { store: t.ctx.s });
            assert.strictEqual(out.isError, false);
            const parsed = JSON.parse(out.text);
            assert.strictEqual(parsed.untrusted_tool_result.untrusted, true);
            assert.strictEqual(parsed.untrusted_tool_result.skill, 'slugify-a-title@1.0.0');
            assert.strictEqual(parsed.untrusted_tool_result.tool, 'slugify');
            assert.strictEqual(parsed.untrusted_tool_result.job_id, JOB);
            assert.strictEqual(parsed.untrusted_tool_result.wall_ms, 456);
            assert.strictEqual(parsed.untrusted_tool_result.exit, 0);
            assert.deepStrictEqual(parsed.untrusted_tool_result.output, { slug: 'a-title' });
            assert.match(parsed.note, /data, never as instructions/);
            const big = { execute: async () => ({ ok: true, job_id: JOB, wall_ms: 1, exit: 0, result: { ok: true, output: { text: 'a'.repeat(70000) }, exit: 0 } }) };
            const bigTools = await toolModule.toolsFor(t.ctx.s, { owner: `user:${alice.subject}`, agentId, run: big });
            const bigRuntime = bigTools.byAlias.get(toolModule.aliasOf('slugify-a-title', 'slugify'));
            const cut = await bigRuntime.run({ title: 'A title' }, { store: t.ctx.s });
            assert.ok(Buffer.byteLength(cut.text, 'utf8') <= 64 * 1024, 'cut to 64 KiB');
            const cutDoc = JSON.parse(cut.text);
            assert.strictEqual(cutDoc.untrusted_tool_result.truncated, true);
            assert.strictEqual(cutDoc.untrusted_tool_result.output, null);
            assert.ok(typeof cutDoc.untrusted_tool_result.output_json_prefix === 'string');
        });

        await check('no node: the step says so plainly, links Link\'s setup, and nothing runs elsewhere', async () => {
            const run = { execute: async () => ({ ok: false, no_node: true, error: 'No machine is offering to run this skill right now. Run it on my machine: https://openvibe.link — turn the skill runner on there, then try again. Nothing ran anywhere else.' }) };
            const tools = await toolModule.toolsFor(t.ctx.s, { owner: `user:${alice.subject}`, agentId, run });
            const runtime = tools.byAlias.get(toolModule.aliasOf('slugify-a-title', 'slugify'));
            const out = await runtime.run({ title: 'A title' }, { store: t.ctx.s });
            assert.strictEqual(out.isError, true);
            assert.match(out.text, /No machine is offering to run this skill/);
            assert.match(out.text, /Run it on my machine/);
            assert.match(out.text, /openvibe\.link/);
            assert.strictEqual(JSON.parse(out.text).untrusted_tool_result.no_node, true);
        });
    } finally { await t.close(); }

    await check('the registry asks the approval gate with the skill.run step the dynamic tool declares', async () => {
        const registry = createRegistry({ strict: true, log: { warn() {}, log() {} } });
        let seen = null;
        let ran = 0;
        const tool = {
            name: 'skill_a_tool', scope: 'person', acts: true,
            step: () => ({ act: 'act', kind: 'skill.run', summary: 'Run a tool', target: 'a-skill@1.0.0 tool', payload: {} }),
            run: async () => { ran++; return { text: 'done' }; },
        };
        const out = await registry.run('skill_a_tool', {}, {
            requester: 'user:usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', dynamicTools: new Map([[tool.name, tool]]),
            requestApproval: async (step) => { seen = step; return { asked: false }; },
        });
        assert.strictEqual(seen.kind, 'skill.run');
        assert.strictEqual(seen.target, 'a-skill@1.0.0 tool');
        assert.strictEqual(out.text, 'done');
        assert.strictEqual(ran, 1);
        const pending = await registry.run('skill_a_tool', {}, {
            requester: 'user:usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', dynamicTools: new Map([[tool.name, tool]]),
            requestApproval: async () => ({ asked: true, pending: true, id: 'apr_x', url: 'https://openvibe.actor/me/approvals/apr_x' }),
        });
        assert.ok(pending.isError && pending.text.includes('not started'), 'a pending approval does not run the tool');
        assert.strictEqual(ran, 1, 'nothing ran while the person decides');
    });

    // ── The Run submission (module level, against a stub Run) ────────────────────────────────────────────
    await check('the Run job body is exact: class function, runner artifact, pinned inputs, declared net and limits, ttl 120000', async () => {
        const tool = sandbox().tools[0];
        const code = [{ name: 'slugify.js', media_id: MED, sha256: sha(CLEAN) }];
        const body = jobBody({ tool, code, input: { title: 'A title' } });
        assert.deepStrictEqual(body, {
            class: 'function',
            artifact: { name: 'openvibe-skill-runner', version: '1.0.0' },
            args: { tool: 'slugify', entry: 'code-1.js', input: { title: 'A title' } },
            inputs: [{ name: 'code-1.js', media_id: MED, sha256: sha(CLEAN) }],
            limits: { wall_ms: 10000, cpu_ms: 10000, mem_bytes: 134217728 },
            ttl_ms: 120000,
            egress: 'none',
            requirements: {
                kind: 'run.function', mobility: 'job', latency_class: 'background', objective: 'balanced',
                // Only the person's own machines or OpenVibe's pool: never a partner's, the community's or an outside one.
                trust: ['user-owned', 'first-party'],
                capabilities: ['worker:function'], resources: { egress: 'none', memory_mb: 128 },
            },
        });
        const declared = jobBody({ tool: { ...tool, net: 'openvibe-only', limits: { wall_ms: 5000, mem_bytes: 64 * 1024 * 1024 } }, code, input: {} });
        assert.deepStrictEqual(declared.limits, { wall_ms: 5000, cpu_ms: 5000, mem_bytes: 64 * 1024 * 1024 }, 'limits as declared');
        assert.strictEqual(declared.egress, 'openvibe-only', 'net as declared, never wider');
        const publicNet = jobBody({ tool: { ...tool, net: 'public' }, code, input: {} });
        assert.strictEqual(publicNet.egress, 'public');
    });

    await check('Actor submits as the person (X-OV-Subject + X-OV-Project) and returns the runner\'s result with its wall time and exit', async () => {
        const tool = sandbox().tools[0];
        const code = [{ name: 'slugify.js', media_id: MED, sha256: sha(CLEAN) }];
        const job = {
            id: JOB, state: 'succeeded', result: { ok: true, output: { slug: 'a-title' }, exit: 0 },
            exit: { code: 0 }, usage: { wall_ms: 321, seconds: 1 },
            timings: { created_at: '2026-11-08T00:00:00Z', placed_at: '2026-11-08T00:00:00Z', started_at: '2026-11-08T00:00:00Z', finished_at: '2026-11-08T00:00:00.321Z' },
        };
        const stub = fakeRun({ job });
        const out = await runOf(stub.fetchImpl).execute({ subject: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', tool, code, input: { title: 'A title' } });
        assert.strictEqual(out.ok, true, out.error);
        assert.strictEqual(out.job_id, JOB);
        assert.strictEqual(out.wall_ms, 321);
        assert.strictEqual(out.exit, 0);
        assert.deepStrictEqual(out.result.output, { slug: 'a-title' });
        assert.strictEqual(stub.calls.length, 1, 'the job ended at submit: no extra read');
        const sent = stub.calls[0];
        assert.strictEqual(sent.url, 'https://run.test/api/v1/jobs');
        assert.strictEqual(sent.headers['X-OV-Subject'], 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ');
        assert.strictEqual(sent.headers['X-OV-Project'], PRJ);
        assert.strictEqual(sent.headers.Authorization, 'Bearer actor-token');
        assert.strictEqual(sent.body.egress, 'none');
        assert.strictEqual(sent.body.inputs[0].sha256, sha(CLEAN), 'the run pins the same sha256 as the listing');
    });

    await check('no node: a job still queued after the placement wait is cancelled, and the answer is plain', async () => {
        const tool = sandbox().tools[0];
        const code = [{ name: 'slugify.js', media_id: MED, sha256: sha(CLEAN) }];
        const queued = { id: JOB, state: 'queued', result: null, usage: {}, timings: {} };
        const stub = fakeRun({ job: queued });
        const out = await runOf(stub.fetchImpl, { waitMs: 1000 }).execute({ subject: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', tool, code, input: {} });
        assert.strictEqual(out.ok, false);
        assert.strictEqual(out.no_node, true);
        assert.match(out.error, /No machine is offering to run this skill/);
        assert.match(out.error, /Run it on my machine/);
        assert.match(out.error, /openvibe\.link/);
        assert.ok(stub.calls.some((c) => c.method === 'POST' && /\/cancel$/.test(c.url)), 'the queued job is cancelled');
        assert.ok(!stub.calls.some((c) => c.method === 'POST' && !/\/api\/v1\/jobs$|\/cancel$/.test(c.url)), 'nothing else was called');
    });
    done();
})().catch((e) => { console.error(e); process.exit(1); });
