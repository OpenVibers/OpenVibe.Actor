'use strict';
/**
 * The approval floor reaches every acting tool (plan §12 A-2). levels.decide already asks for money, a
 * password, a deletion and a new recipient at every level (test/agent-levels.test.js); this proves the
 * tools themselves go through it: the act and category are named, a full-level agent still asks, an
 * auto-edits agent passes an edit and asks for a send, reading the agent's own files never asks, the
 * old runtime path asks too, and the engine hands the gate to a loop with the task's effective level.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');
const { createRegistry } = require('../server/runtime/tools');
const { createOpenVibeTools } = require('../server/agents/tools');
const { stepFor } = require('../server/agents/actions');
const levels = require('../server/agents/levels');
const approvals = require('../server/agents/approvals');
const contacts = require('../server/agents/contacts');

const ME = 'user:usr_01M4W5JBFEG3QG9ER8W1A2K0RX';
const OTHER = 'user:usr_01M4W5JBFEG3QG9ER8W1A2K0RY';
const SAME = { 'sec-fetch-site': 'same-origin' };

/** A small registry of the tool names under test: nothing reaches a computer or Space, a counter says who ran. */
function testRegistry() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-gate-'));
    for (const name of ['computer_run', 'computer_write', 'computer_browser']) {
        fs.writeFileSync(path.join(dir, `${name}.js`), `module.exports = {
            name: '${name}', description: 'test ${name}', input: { type: 'object', properties: {} }, scope: 'person', acts: true,
            async run() { globalThis.__gateRuns.push('${name}'); return { text: 'ran' }; },
        };`);
    }
    fs.writeFileSync(path.join(dir, 'computer_read.js'), `module.exports = {
        name: 'computer_read', description: 'test read', input: { type: 'object', properties: {} }, scope: 'person',
        async run() { globalThis.__gateRuns.push('computer_read'); return { text: 'read' }; },
    };`);
    fs.writeFileSync(path.join(dir, 'make_file.js'), `module.exports = {
        name: 'make_file', description: 'test own file', input: { type: 'object', properties: {} }, scope: 'person', acts: true,
        async run() { globalThis.__gateRuns.push('make_file'); return { text: 'made' }; },
    };`);
    return createRegistry({ dir, strict: true, log: { warn() {}, log() {} } });
}

/** The engine's gate, without a database: classify the step, let levels.decide, and stop when it asks. */
function gate(level, asked) {
    return async (step) => {
        const categories = levels.classify({ category: step.category, summary: step.summary, payload: step.payload });
        const decision = await levels.decide({ level, categories, act: step.act, models: null, summary: step.summary, payload: step.payload });
        if (!decision.ask) return null;
        asked.push({ ...step, categories, floor: decision.floor });
        return { pending: true, id: 'apr_01JAB2C3D4E5F6G7H8J9K0MNPS', url: 'https://openvibe.actor/me/approvals/apr_01JAB2C3D4E5F6G7H8J9K0MNPS' };
    };
}

(async () => {
    const registry = testRegistry();
    globalThis.__gateRuns = [];

    await check('one per category: a full-level agent still asks, and the tool does not run', async () => {
        const cases = [
            ['money', 'computer_browser', { machine: 'dev_01JAB2C3D4E5F6G7H8J9K0MNPS', action: 'click', text: 'Buy now' }],
            ['password', 'computer_browser', { machine: 'dev_01JAB2C3D4E5F6G7H8J9K0MNPS', action: 'fill', selector: '#password', text: 'hunter2' }],
            ['delete', 'computer_run', { machine: 'dev_01JAB2C3D4E5F6G7H8J9K0MNPS', argv: ['rm', '-rf', 'build'] }],
            ['new_recipient', 'computer_browser', { machine: 'dev_01JAB2C3D4E5F6G7H8J9K0MNPS', action: 'click', text: 'Send to bob@example.com' }],
        ];
        for (const [category, tool, input] of cases) {
            const asked = [];
            const out = await registry.run(tool, input, { requester: ME, requestApproval: gate('full', asked) });
            assert.strictEqual(out.isError, true, `${category}: the call was refused`);
            assert.match(out.text, /not started: the person must approve it first/, `${category}: ${out.text}`);
            assert.strictEqual(asked.length, 1, `${category}: asked once`);
            assert.ok(asked[0].categories.includes(category), `${category}: got ${JSON.stringify(asked[0])}`);
            assert.strictEqual(asked[0].act === 'edit' || asked[0].act === 'act', true, `${category}: a known act`);
            assert.ok(!globalThis.__gateRuns.includes(tool), `${category}: ${tool} never ran`);
            if (category === 'password') {
                assert.strictEqual(asked[0].payload.text, '[redacted]', 'the password is not in the approval card');
                assert.ok(!JSON.stringify(asked[0]).includes('hunter2'), 'the password is nowhere in the request');
            }
        }
    });

    await check('auto-edits passes an edit and asks for a send', async () => {
        const asked = [];
        const edit = await registry.run('computer_write', { machine: 'dev_x', path: '/tmp/a.txt', text: 'hi' }, { requester: ME, requestApproval: gate('auto-edits', asked) });
        assert.ok(!edit.isError, edit.text);
        assert.strictEqual(globalThis.__gateRuns.filter((n) => n === 'computer_write').length, 1, 'the edit ran');
        assert.strictEqual(asked.length, 0, 'the edit did not ask');
        const send = await registry.run('computer_browser', { machine: 'dev_x', action: 'click', text: 'Send to bob@example.com' }, { requester: ME, requestApproval: gate('auto-edits', asked) });
        assert.strictEqual(send.isError, true);
        assert.strictEqual(asked.length, 1, 'the send asked');
        assert.strictEqual(globalThis.__gateRuns.filter((n) => n === 'computer_browser').length, 0, 'the send did not run');
    });

    await check('approve-for-me with no reviewer asks the person', async () => {
        const asked = [];
        const out = await registry.run('computer_browser', { machine: 'dev_x', action: 'click', text: 'Open the page' }, { requester: ME, requestApproval: gate('approve-for-me', asked) });
        assert.strictEqual(out.isError, true);
        assert.strictEqual(asked.length, 1, 'the ordinary act asked when no reviewer exists');
    });

    await check('reading the agent\'s own files never asks; Actor\'s own working state does not either', async () => {
        const asked = [];
        globalThis.__gateRuns = [];
        const read = await registry.run('computer_read', { machine: 'dev_x', path: '/tmp/a.txt' }, { requester: ME, requestApproval: gate('ask', asked) });
        assert.ok(!read.isError, read.text);
        const own = await registry.run('make_file', { name: 'notes.md', text: 'hi' }, { requester: ME, requestApproval: gate('ask', asked) });
        assert.ok(!own.isError, own.text);
        assert.strictEqual(asked.length, 0, 'nothing asked');
        assert.deepStrictEqual(globalThis.__gateRuns, ['computer_read', 'make_file']);
    });

    await check('the old runtime path asks through the same gate, and nothing reaches the computer', async () => {
        let ran = 0;
        const computers = { enabled: true, run: async () => { ran++; return { ok: true }; } };
        const tools = createOpenVibeTools({ config: { services: {} }, computers, now: () => 0 });
        const out = await tools.call('computer_run', { machine: 'dev_x', argv: ['rm', '-rf', 'build'] }, {
            requester: ME,
            requestApproval: async (step) => ({ pending: true, id: 'apr_01JAB2C3D4E5F6G7H8J9K0MNPS', url: `https://openvibe.actor/me/approvals/${step.category}` }),
        });
        assert.match(out, /not started: the person must approve it first/);
        assert.strictEqual(ran, 0, 'the computer was never asked to run');
    });

    // ── The engine hands the same gate to the loop, with the task's assignment level ──
    const seen = [];
    const t = await boot({
        loop: {
            close: async () => {},
            run: async (args) => {
                seen.push(args);
                if (args.task.includes('delete')) {
                    await args.requestApproval({ kind: 'actor.action', ...stepFor('computer_run', { machine: 'dev_x', argv: ['rm', '-rf', 'build'] }) });
                } else {
                    await args.requestApproval({ kind: 'actor.action', ...stepFor('computer_write', { machine: 'dev_x', path: '/tmp/a.txt', text: 'hi' }) });
                    await args.requestApproval({ kind: 'actor.action', ...stepFor('computer_browser', { machine: 'dev_x', action: 'click', text: 'Send to bob@example.com' }) });
                }
                return { text: 'Done.', sources: [], evidence: [], model: 'fake' };
            },
        },
    });
    try {
        const ada = t.network.addUser('ada');
        const bo = t.network.addUser('bo');
        const owner = `user:${ada.subject}`;
        const agent = async (name, level) => (await contacts.create(t.ctx.s, t.config, owner, { name, level })).row;
        const full = await agent('Full', 'full');
        const auto = await agent('Auto', 'auto-edits');
        const create = (body) => t.get('/api/v1/tasks', { as: ada, json: body, headers: SAME });

        await check('a full-level agent still asks before a deletion, through the engine\'s gate', async () => {
            const r = await create({ task: 'delete the build directory', agent_id: full.id, level: 'full' });
            assert.strictEqual(r.status, 201, r.text);
            const row = await t.waitFor(r.json().id);
            assert.strictEqual(row.state, 'succeeded', JSON.stringify(row.error_detail));
            const ask = await t.ctx.s.db.maybe('SELECT * FROM actor_approvals WHERE task_id = $1', [row.id]);
            assert.ok(ask, 'the approval was recorded');
            assert.deepStrictEqual([ask.kind, ask.state], ['computer.run', 'pending']);
            assert.strictEqual(JSON.parse(typeof ask.payload === 'string' ? ask.payload : JSON.stringify(ask.payload)).argv[0], 'rm');
        });

        await check('an auto-edits agent passes the edit and asks for the send', async () => {
            const r = await create({ task: 'edit the file and send it', agent_id: auto.id, level: 'auto-edits' });
            assert.strictEqual(r.status, 201, r.text);
            const row = await t.waitFor(r.json().id);
            assert.strictEqual(row.state, 'succeeded', `${row.error_detail}\n${t.logs().slice(-2000)}`);
            const asks = await t.ctx.s.db.many('SELECT * FROM actor_approvals WHERE task_id = $1 ORDER BY created_at', [row.id]);
            assert.strictEqual(asks.length, 1, 'only the send asked');
            assert.match(asks[0].summary, /Send to bob@example\.com/);
            const args = seen.find((s) => s.task.includes('send it'));
            assert.ok(args, 'the loop ran with the gate');
        });

        await check('the approval belongs to its owner only', async () => {
            const rows = await t.ctx.s.db.many('SELECT * FROM actor_approvals ORDER BY created_at DESC LIMIT 1');
            const a = rows[0];
            assert.strictEqual((await t.get(`/me/approvals/${a.id}`, { as: bo })).status, 404);
            assert.strictEqual((await t.get(`/me/approvals/${a.id}`, { as: ada })).status, 200);
            assert.strictEqual(approvals.KINDS.includes('actor.action'), true);
            assert.strictEqual((await t.get('/api/v1/assignments/not-an-id', { as: bo })).status, 404);
        });
    } finally {
        await t.close();
    }

    done();
})().catch((e) => { console.error(e); process.exit(1); });
