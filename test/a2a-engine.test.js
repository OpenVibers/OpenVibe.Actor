'use strict';
// Outside agents over A2A (plan §AD.19, 11-19: "Next: A2A for outside agents" in group conversations):
//   - the client speaks A2A 0.3's JSON-RPC (message/send, then tasks/get while the task works) and reads the card at
//     /.well-known/agent-card.json, falling back to /.well-known/agent.json and the earlier plain POST (Actor's own
//     /a2a/v1/tasks answers a JSON-RPC body with 422);
//   - a card that prefers another transport but lists a JSON-RPC interface is reached on that interface;
//   - the a2a engine ({ kind: 'a2a', url }) answers a task through the outside agent with the person's own key for it
//     when they connected one, refuses a failed or turned-down task in words, and a conversation's next turn carries
//     the agent's contextId so it keeps its own memory of the conversation.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const { boot, check, done } = require('./helpers/boot');
const a2a = require('../server/connections/a2a');
const { parseEngine, createEngines, label, keyOf } = require('../server/engines');

const SAME = { 'sec-fetch-site': 'same-origin' };

/** A self-signed certificate for the fake agents (a test only; nothing secret is written to the repo). */
function cert(dir) {
    const key = path.join(dir, 'key.pem');
    const crt = path.join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '1', '-subj', '/CN=agent.test'], { stdio: 'ignore' });
    return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
}

/** Three fake agents on one server: /modern (A2A 0.3 JSON-RPC), /legacy (the earlier plain shape), /grpc (a card that prefers gRPC). */
function fakeAgents() {
    const calls = [];
    let base = '';
    let tasks = 0;
    const words = (msg) => ((msg && msg.parts) || []).filter((p) => p.kind === 'text').map((p) => p.text).join('\n');
    const server = https.createServer(cert(fs.mkdtempSync(path.join(os.tmpdir(), 'actor-a2a-'))), (req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            let msg = null;
            try { msg = body ? JSON.parse(body) : null; } catch { msg = null; }
            const url = req.url.split('?')[0];
            calls.push({ method: req.method, url, body: msg, headers: req.headers });
            const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
            const rpc = (result) => send(200, { jsonrpc: '2.0', id: msg.id, result });
            if (url === '/modern/.well-known/agent-card.json') return send(200, { name: 'Modern Agent', url: `${base}/modern/rpc`, preferredTransport: 'JSONRPC', protocolVersion: '0.3.0' });
            if (url === '/grpc/.well-known/agent-card.json') {
                return send(200, { name: 'Grpc Agent', url: `${base}/grpc/grpc`, preferredTransport: 'GRPC', additionalInterfaces: [{ transport: 'GRPC', url: `${base}/grpc/grpc` }, { transport: 'JSONRPC', url: `${base}/modern/rpc` }] });
            }
            if (url === '/legacy/.well-known/agent.json') return send(200, { name: 'Old Agent', url: `${base}/legacy/a2a/v1/tasks` });
            if (url === '/legacy/a2a/v1/tasks') {
                if (msg && msg.jsonrpc) return send(422, { type: 'about:blank', title: 'invalid', code: 'actor.a2a.invalid' });
                const text = ((msg && msg.message && msg.message.parts) || []).map((p) => p.text).join('');
                return send(200, { id: 'a2a_1', state: 'completed', answer: `old: ${text}` });
            }
            if (url === '/modern/rpc' && msg && msg.jsonrpc === '2.0') {
                if (msg.method === 'message/send') {
                    const text = words(msg.params && msg.params.message);
                    const ctx = (msg.params.message && msg.params.message.contextId) || 'ctx-1';
                    if (/boom/.test(text)) return send(200, { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'internal trouble' } });
                    if (/quick/.test(text)) return rpc({ kind: 'message', role: 'agent', messageId: 'm1', contextId: ctx, parts: [{ kind: 'text', text: `quick: ${text}` }] });
                    if (/fail/.test(text)) return rpc({ kind: 'task', id: 't-f', contextId: ctx, status: { state: 'failed', message: { kind: 'message', role: 'agent', parts: [{ kind: 'text', text: 'cannot do that' }] } } });
                    tasks += 1;
                    return rpc({ kind: 'task', id: `t-${tasks}`, contextId: ctx, status: { state: 'working' }, metadata: { text } });
                }
                if (msg.method === 'tasks/get') {
                    const sent = calls.filter((c) => c.body && c.body.method === 'message/send').pop();
                    const text = words(sent.body.params.message);
                    return rpc({ kind: 'task', id: msg.params.id, contextId: sent.body.params.message.contextId || 'ctx-1', status: { state: 'completed' }, artifacts: [{ artifactId: 'a1', parts: [{ kind: 'text', text: `done: ${text}` }] }] });
                }
                return send(200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
            }
            send(404, { error: 'not found' });
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        base = `https://agent.test:${port}`;
        resolve({
            base, calls, close: () => new Promise((r) => server.close(r)),
            guard: { lookup: (host, opts, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]), isAllowed: () => true, ports: [String(port)] },
        });
    }));
}

(async () => {
    const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const fake = await fakeAgents();
    const g = fake.guard;
    const sends = () => fake.calls.filter((c) => c.body && c.body.method === 'message/send');
    try {
        await check('addresses: a card URL gives its base; the JSON-RPC interface is picked from the card', async () => {
            assert.strictEqual(a2a.baseOf('https://Agent.Example.com/x/.well-known/agent-card.json?y=1#z'), 'https://agent.example.com/x');
            assert.strictEqual(a2a.baseOf('https://agent.example.com/x/'), 'https://agent.example.com/x');
            assert.strictEqual(a2a.baseOf('https://agent.example.com/.well-known/agent.json'), 'https://agent.example.com');
            assert.strictEqual(a2a.baseOf('not a url'), '');
            assert.strictEqual(a2a.endpointOf({ url: 'https://a/rpc' }), 'https://a/rpc');
            assert.strictEqual(a2a.endpointOf({ url: 'https://a/g', preferredTransport: 'GRPC', additionalInterfaces: [{ transport: 'JSONRPC', url: 'https://a/j' }] }), 'https://a/j');
            assert.strictEqual(a2a.endpointOf({ url: 'https://a/g', preferredTransport: 'GRPC' }), 'https://a/g', 'no JSON-RPC interface: the card url');
            assert.strictEqual(a2a.answerText({ kind: 'message', parts: [{ kind: 'text', text: 'a' }, { kind: 'file' }, { type: 'text', text: 'b' }] }), 'a\nb');
        });

        await check('JSON-RPC: message/send, then tasks/get until the task completes; the key goes as a bearer', async () => {
            const out = await a2a.sendTask(`${fake.base}/modern`, { text: 'hello there', token: 'tok-123', pollMs: 20, ...g });
            assert.strictEqual(out.protocol, 'jsonrpc');
            assert.strictEqual(out.state, 'completed');
            assert.strictEqual(out.text, 'done: hello there');
            assert.strictEqual(out.card.name, 'Modern Agent');
            const sent = sends().pop();
            assert.strictEqual(sent.headers.authorization, 'Bearer tok-123');
            assert.strictEqual(sent.body.params.message.role, 'user');
            assert.deepStrictEqual(sent.body.params.message.parts, [{ kind: 'text', text: 'hello there' }]);
            assert.ok(sent.body.params.message.messageId, 'every message has its id');
            assert.ok(fake.calls.some((c) => c.body && c.body.method === 'tasks/get' && c.body.params.id === 't-1'), 'asked about the task while it worked');
        });

        await check('a card URL as the address, a direct Message answer, and the contextId passed on', async () => {
            const out = await a2a.sendTask(`${fake.base}/modern/.well-known/agent-card.json`, { text: 'quick one', contextId: 'ctx-9', pollMs: 20, ...g });
            assert.strictEqual(out.text, 'quick: quick one');
            assert.strictEqual(out.state, 'completed');
            assert.strictEqual(sends().pop().body.params.message.contextId, 'ctx-9');
        });

        await check('the earlier shape: agent.json, and a 422 to JSON-RPC falls back to the plain POST', async () => {
            const out = await a2a.sendTask(`${fake.base}/legacy`, { text: 'hi', pollMs: 20, ...g });
            assert.strictEqual(out.protocol, 'legacy');
            assert.strictEqual(out.text, 'old: hi');
            const posts = fake.calls.filter((c) => c.url === '/legacy/a2a/v1/tasks');
            assert.strictEqual(posts.length, 2, 'JSON-RPC first, then the plain shape');
            assert.ok(posts[0].body.jsonrpc && !posts[1].body.jsonrpc);
            assert.deepStrictEqual(posts[1].body.message.parts, [{ type: 'text', text: 'hi' }]);
        });

        await check('a card that prefers gRPC is reached on its JSON-RPC interface', async () => {
            const out = await a2a.sendTask(`${fake.base}/grpc`, { text: 'quick via grpc card', pollMs: 20, ...g });
            assert.strictEqual(out.text, 'quick: quick via grpc card');
            assert.ok(!fake.calls.some((c) => c.url === '/grpc/grpc'), 'nothing posted to the gRPC address');
        });

        await check('a failed task says why; a JSON-RPC error is thrown in words', async () => {
            const out = await a2a.sendTask(`${fake.base}/modern`, { text: 'please fail', pollMs: 20, ...g });
            assert.strictEqual(out.state, 'failed');
            assert.strictEqual(out.text, 'cannot do that');
            await assert.rejects(() => a2a.sendTask(`${fake.base}/modern`, { text: 'boom', pollMs: 20, ...g }), (err) => err.code === 'actor.a2a.rpc_error' && /internal trouble/.test(err.message));
        });

        await check('the a2a engine: checked in words, labelled by host', async () => {
            assert.deepStrictEqual(parseEngine({ kind: 'a2a', url: 'https://agents.example.com/bot#x' }), { engine: { kind: 'a2a', url: 'https://agents.example.com/bot' } });
            assert.match(parseEngine({ kind: 'a2a' }).error, /https address/);
            assert.match(parseEngine({ kind: 'a2a', url: 'http://agents.example.com' }).error, /https address/);
            assert.match(parseEngine({ kind: 'a2a', url: 'https://me:pw@agents.example.com' }).error, /https address/);
            assert.match(parseEngine({ kind: 'model', url: 'https://agents.example.com' }).error, /only the a2a engine/);
            assert.match(parseEngine({ kind: 'a2a', url: 'https://a.example', model: 'x/y' }).error, /only the agent, model and decisions/);
            assert.strictEqual(label({ kind: 'a2a', url: 'https://agents.example.com/bot' }), 'An outside agent · agents.example.com');
            assert.strictEqual(keyOf({ kind: 'a2a', url: 'https://agents.example.com/bot' }), 'a2a:agents.example.com');
        });

        await check('the a2a engine answers with the person\'s own key, and refuses a failed task in words', async () => {
            const asked = [];
            const connectors = { a2aKeyFor: async (owner, url) => { asked.push([owner, url]); return { token: 'their-key', headerName: null }; }, guardOpts: () => g };
            const e = createEngines({ models: null, connectors });
            const steps = [];
            const args = (task, extra = {}) => ({ task, subject: 'u1', url: `${fake.base}/modern`, emit: async (s) => steps.push(s), ...extra });
            const out = await e.a2a(args('quick hello', { contextId: 'ctx-7' }));
            assert.strictEqual(out.text, 'quick: quick hello');
            assert.deepStrictEqual(out.sources, [{ url: `${fake.base}/modern`, title: 'Modern Agent' }]);
            assert.strictEqual(out.a2a.contextId, 'ctx-7');
            assert.strictEqual(out.a2a.agent, 'Modern Agent');
            assert.deepStrictEqual(asked, [['user:u1', `${fake.base}/modern`]]);
            assert.strictEqual(sends().pop().headers.authorization, 'Bearer their-key');
            assert.match(steps[0].text, /Asking the outside agent at agent\.test:\d+ with your key for it/);
            await assert.rejects(() => e.a2a(args('please fail')), (err) => err.code === 'actor.a2a.failed' && /Modern Agent could not do it: cannot do that/.test(err.message));
            await assert.rejects(() => e.a2a(args('boom')), (err) => err.code === 'actor.a2a.failed' && /did not answer: the agent refused: internal trouble/.test(err.message));
        });

        const t = await boot({ guard: g });
        try {
            const ada = t.network.addUser('ada');
            await check('a conversation on an outside agent: the answer, then the next turn keeps the agent\'s contextId', async () => {
                const started = await t.get('/api/v1/runs', { as: ada, headers: SAME, json: { text: 'quick start', engine: { kind: 'a2a', url: `${fake.base}/modern` } } });
                assert.strictEqual(started.status, 201, started.text);
                const runId = started.json().id;
                const first = await t.waitFor(runId);
                const r1 = typeof first.result === 'string' ? JSON.parse(first.result) : first.result;
                assert.strictEqual(first.state, 'succeeded', JSON.stringify(r1));
                assert.strictEqual(r1.answer, 'quick: quick start');
                assert.strictEqual(r1.agent, 'a2a');
                assert.strictEqual(r1.a2a.contextId, 'ctx-1');
                assert.strictEqual(sends().pop().body.params.message.contextId, undefined, 'a new conversation starts without one');
                const next = await t.get(`/api/v1/runs/${runId}/messages`, { as: ada, headers: SAME, json: { text: 'quick again' } });
                assert.strictEqual(next.status, 202, next.text);
                const rows = await t.ctx.s.db.many('SELECT * FROM tasks WHERE requester = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [`user:${ada.subject}`]);
                const second = await t.waitFor(rows[0].id);
                assert.strictEqual(second.state, 'succeeded');
                assert.strictEqual(sends().pop().body.params.message.contextId, 'ctx-1', 'the next turn continues the agent\'s conversation');
            });
            await check('an outside agent that fails ends the turn as failed, in its words', async () => {
                const started = await t.get('/api/v1/runs', { as: ada, headers: SAME, json: { text: 'please fail', engine: { kind: 'a2a', url: `${fake.base}/modern` } } });
                const row = await t.waitFor(started.json().id);
                assert.strictEqual(row.state, 'failed');
                assert.strictEqual(row.error_code, 'actor.a2a.failed');
                assert.match(row.error_detail, /cannot do that/);
            });
        } finally { await t.close(); }
    } finally {
        await fake.close();
        if (prevTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls;
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
