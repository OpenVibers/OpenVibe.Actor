'use strict';
/**
 * Code mode (plan §AD.26; the owner, 11-17, sending Cloudflare's Code Mode and Claude Code's): the run's tools as typed
 * signatures to search, and a script that calls them in a sandbox and returns only what it needs.
 *   • signatures and search: the shape a script calls, the best matches first;
 *   • a script chains calls, filters, logs and returns; only the value comes back; a tool's failure is a thrown error;
 *   • the limits: a tool the run does not have, too many calls, too big a value, too long a run;
 *   • the sandbox holds: no require, no process, no files, no network, no way out through a host function, no eval.
 *   node test/code-mode.test.js
 */
const assert = require('assert');
const { runCode, signatureOf, searchTools } = require('../server/runtime/code-mode');

const results = [];
const ok = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { results.push(e); console.log(`  ✗ ${name}\n      ${(e.stack || e).toString().split('\n').slice(0, 6).join('\n      ')}`); } };

const DEFS = [
    { type: 'function', function: { name: 'openvibe_design_audit_page', description: 'Audit a public web page\'s markup against OpenVibe\'s design rules.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
    { type: 'function', function: { name: 'dns-lookup', description: 'Look up DNS records for a domain.', parameters: { type: 'object', properties: { domain: { type: 'string' }, type: { type: 'string', enum: ['A', 'MX', 'TXT'] } }, required: ['domain'] } } },
    { type: 'function', function: { name: 'list_my_computers', description: 'The person\'s computers and whether each is online.', parameters: { type: 'object', properties: {} } } },
];
const fakeCall = (log) => async (name, input) => {
    log.push([name, input]);
    if (name === 'openvibe_design_audit_page') return { findings: [{ id: 'viewport', severity: 'high' }, { id: 'img-alt', severity: 'medium' }, { id: 'spinners', severity: 'medium' }], url: input.url };
    if (name === 'dns-lookup') return { records: [`${input.domain} ${input.type || 'A'} 1.2.3.4`] };
    if (name === 'list_my_computers') return { ok: false, error: 'Link is not answering' };
    return null;
};
const names = DEFS.map((d) => d.function.name);

(async () => {
    await ok('signatures and search: the shape a script calls, the best first', async () => {
        assert.strictEqual(signatureOf(DEFS[0]), 'openvibe_design_audit_page(input: { url: string }): Promise<any>');
        assert.strictEqual(signatureOf(DEFS[1]), 'dns_lookup(input: { domain: string; type?: "A" | "MX" | "TXT" }): Promise<any>');
        const found = searchTools(DEFS, 'audit a page');
        assert.strictEqual(found[0].name, 'openvibe_design_audit_page');
        assert.deepStrictEqual(searchTools(DEFS, 'dns records').map((x) => x.name), ['dns_lookup']);
        assert.strictEqual(searchTools(DEFS, '').length, 3, 'no words: every tool');
    });

    await ok('a script chains calls, filters and returns only what it needs', async () => {
        const log = [];
        const out = await runCode(`
            const pages = ['https://a.example/', 'https://b.example/'];
            const high = [];
            for (const url of pages) {
                const r = await tools.openvibe_design_audit_page({ url });
                high.push(...r.findings.filter((f) => f.severity === 'high').map((f) => url + ' ' + f.id));
            }
            const dns = await tools.dns_lookup({ domain: 'a.example', type: 'MX' });
            console.log('checked', pages.length, 'pages');
            return { high, mx: dns.records[0] };
        `, { names, call: fakeCall(log) });
        assert.strictEqual(out.ok, true, out.error);
        assert.deepStrictEqual(out.value, { high: ['https://a.example/ viewport', 'https://b.example/ viewport'], mx: 'a.example MX 1.2.3.4' });
        assert.deepStrictEqual(out.logs, ['checked 2 pages']);
        assert.strictEqual(out.calls, 3);
        assert.deepStrictEqual(log.map(([n]) => n), ['openvibe_design_audit_page', 'openvibe_design_audit_page', 'dns-lookup'], 'a hyphened tool is called by its own name');
    });

    await ok('a tool\'s failure is an error the script may catch', async () => {
        const out = await runCode(`try { await tools.list_my_computers({}); return 'no'; } catch (e) { return 'caught: ' + e.message; }`, { names, call: fakeCall([]) });
        assert.deepStrictEqual([out.ok, out.value], [true, 'caught: Link is not answering']);
        const thrown = await runCode('await tools.list_my_computers({});', { names, call: fakeCall([]) });
        assert.deepStrictEqual([thrown.ok, thrown.error], [false, 'Link is not answering']);
    });

    await ok('the limits: unknown tools, too many calls, too big a value, too long a run', async () => {
        const unknown = await runCode('return await tools.delete_everything({})', { names, call: fakeCall([]) });
        assert.strictEqual(unknown.ok, false);
        assert.match(unknown.error, /tools.delete_everything is not a function/);
        const many = await runCode(`let n = 0; try { for (;;) { await tools.dns_lookup({ domain: 'x' }); n++; } } catch (e) { return [n, e.message]; }`, { names, call: fakeCall([]), limits: { calls: 5 } });
        assert.deepStrictEqual(many.value, [5, 'a script makes at most 5 tool calls']);
        const big = await runCode(`return 'x'.repeat(20000)`, { names, call: fakeCall([]) });
        assert.deepStrictEqual([big.ok, /returned \d+ bytes/.test(big.error)], [false, true]);
        const slow = await runCode('await new Promise(() => {});', { names, call: fakeCall([]), limits: { ms: 1500 } });
        assert.deepStrictEqual([slow.ok, /ran past 2 s/.test(slow.error) || /ran past 1 s/.test(slow.error)], [false, true]);
        const spin = await runCode('for (;;) {}', { names, call: fakeCall([]), limits: { ms: 3000 } });
        assert.strictEqual(spin.ok, false, 'a busy loop is stopped');
    });

    await ok('the sandbox holds: no require, process, files, network, eval or way out through a host function', async () => {
        const tries = {
            require: 'return typeof require',
            process: 'return typeof process',
            fetch: 'return typeof fetch',
            eval: 'try { return eval("1+1"); } catch (e) { return "blocked: " + e.constructor.name; }',
            fn: 'try { return new Function("return 1")(); } catch (e) { return "blocked: " + e.constructor.name; }',
            escape: 'try { const F = tools.dns_lookup.constructor.constructor; return typeof F("return process")(); } catch (e) { return "blocked: " + e.message.slice(0, 60); }',
            escape2: 'try { const p = tools.dns_lookup({ domain: "x" }); const F = p.constructor.constructor; return typeof F("return process")(); } catch (e) { return "blocked: " + e.message.slice(0, 60); }',
        };
        for (const [k, code] of Object.entries(tries)) {
            const out = await runCode(code, { names, call: fakeCall([]) });
            assert.strictEqual(out.ok, true, `${k}: ${out.error}`);
            if (k === 'require' || k === 'process' || k === 'fetch') assert.strictEqual(out.value, 'undefined', `${k} is not there`);
            else assert.match(String(out.value), /^blocked/, `${k}: ${out.value}`);
        }
    });

    await ok('in a run: the read tools behind the two, the acting one direct; a script\'s calls are steps and evidence', async () => {
        const { createLoop } = require('../server/runtime/loop');
        const configLib = require('../server/config');
        const chats = [];
        let n = 0;
        const r = (x) => ({ message: { role: 'assistant', content: x.text || null, ...(x.tools ? { tool_calls: x.tools } : {}) }, text: x.text || '', toolCalls: x.tools || [], cost_usd: 0.0001, model: 'fake-1', family: 'fake', provider: 'fake' });
        const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
        const models = {
            resolve: (tier) => ({ tier, provider: 'fake', model: 'fake-1', family: 'fake', available: true }),
            async chat(req) {
                chats.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
                if (req.tier === 'fast') return r({ text: JSON.stringify({ assumptions: [], steps: [{ goal: 'Look' }, { goal: 'Answer' }] }) });
                n += 1;
                if (n === 1) return r({ tools: [call('c1', 'tools_search', { query: 'look up prices' })] });
                if (n === 2) return r({ tools: [call('c2', 'tools_code', { code: "const a = await tools.lookup({ q: 'gpu' }); const b = await tools.lookup({ q: 'cpu' }); return [a.price, b.price];" })] });
                return r({ text: 'A GPU is 0.31 and a CPU 0.02 [E2] [E3].' });
            },
        };
        const ran = [];
        const DEFS2 = [
            { type: 'function', function: { name: 'lookup', description: 'Look up the price of a thing.', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } } },
            { type: 'function', function: { name: 'send_email', description: 'Send an email for the person.', parameters: { type: 'object', properties: { to: { type: 'string' } } } } },
            { type: 'function', function: { name: 'calculate', description: 'Work out a sum.', parameters: { type: 'object', properties: { expr: { type: 'string' } } } } },
        ];
        const registry = {
            definitions: () => DEFS2,
            get: (name) => ({ acts: name === 'send_email', scope: 'public' }),
            run: async (name, input, ctx) => { ran.push([name, input]); const d = ctx && ctx.dynamicTools && ctx.dynamicTools.get(name); if (d) return d.run(input, ctx); return { text: JSON.stringify({ price: input.q === 'gpu' ? 0.31 : 0.02 }), sources: [{ url: `https://prices.example/${input.q}`, title: input.q }] }; },
        };
        const loop = createLoop({ config: configLib.load({ NODE_ENV: 'test', ACTOR_LOOP_SELF_REFLECTIONS: '0' }), models, registry, log: { warn() {}, log() {} } });
        const events = [];
        const out = await loop.run({ task: 'Compare a GPU and a CPU price', requester: 'user:usr_01JAB2C3D4E5F6G7H8J9K0MNPT', taskId: 'tsk_01JAB2C3D4E5F6G7H8J9K0MNPQ', mode: 'balanced', emit: async (e) => events.push(e), meter: async () => {}, budgetLeft: () => 1, codeMode: true });
        const work = chats.filter((c) => c.tier !== 'fast');
        assert.deepStrictEqual(work[0].tools.map((t) => t.function.name).sort(), ['send_email', 'tools_code', 'tools_search'], 'the acting tool direct, the reads behind the two');
        assert.match(work[0].messages.find((m) => m.role === 'system').content, /This run works in code mode/);
        const searched = JSON.parse(work[1].messages.filter((m) => m.role === 'tool').pop().content);
        assert.match(String(searched.result), /lookup\(input: \{ q: string \}\)/, 'the search answers the signature');
        assert.deepStrictEqual(ran, [['lookup', { q: 'gpu' }], ['lookup', { q: 'cpu' }]], 'the script\'s calls ran through the registry');
        const scripted = JSON.parse(JSON.parse(work[2].messages.filter((m) => m.role === 'tool').pop().content).result);
        assert.deepStrictEqual([scripted.result, scripted.tool_calls, scripted.evidence.length], [[0.31, 0.02], 2, 2]);
        assert.deepStrictEqual(events.filter((e) => e.step === 'tool_call').map((e) => [e.tool, e.call_id]), [['tools_search', 'c1'], ['lookup', 'c2.1'], ['lookup', 'c2.2'], ['tools_code', 'c2']], 'each call inside the script is a step of its own');
        assert.match(out.text, /0\.31/);
        await loop.close(out.state);
    });

    console.log(results.length ? `\n${results.length} failed` : '\nall passed');
    process.exit(results.length ? 1 : 0);
})();
