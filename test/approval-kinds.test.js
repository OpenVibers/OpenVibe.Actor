'use strict';
/**
 * HO1, universal approvals: the trust spine.
 *
 * Every acting tool says which kind of act it is (agents/actions.js, agents/kinds.js) and a plain summary of it;
 * every pending approval reaches the Action Center as a waiting item with the kind, the agent's NAME and its own
 * page; the person may approve once, or approve and allow that exact kind of step for that agent (scoped by kind
 * and target, revocable); the always-ask floor (money, a password, a deletion, a new recipient) is never covered by
 * such a permission; and every decision is in the agent's own activity.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');
const { createRegistry } = require('../server/runtime/tools');
const { stepFor } = require('../server/agents/actions');
const kinds = require('../server/agents/kinds');
const levels = require('../server/agents/levels');
const approvals = require('../server/agents/approvals');
const allows = require('../server/agents/allows');
const contacts = require('../server/agents/contacts');
const items = require('../server/actions/items');

const SAME = { 'sec-fetch-site': 'same-origin' };

// Every acting tool and the kind it is. `null` means Actor's own working state: it never asks.
const EXPECTED = {
    codes_task: 'codes.task',
    computer_browser: 'computer.browser',
    computer_desk: 'computer.desk',
    computer_input: 'computer.input',
    computer_run: 'computer.run',
    computer_write: 'computer.write',
    hand_to_person: null,
    make_chart: null,
    make_file: null,
    remember: null,
    robot_steps: 'robot.move',
    run_tool: 'by-tool',
    schedule_trigger: 'routine',
    space_create: 'space',
    space_files_write: 'space',
    space_publish: 'publish',
};

const SAMPLE = {
    codes_task: { repo: 'ada/site', instruction: 'fix the bug' },
    computer_browser: { machine: 'dev_x', action: 'click', text: 'Send' },
    computer_desk: { machine: 'dev_x', action: 'start' },
    computer_input: { machine: 'dev_x', action: 'type', text: 'hello' },
    computer_run: { machine: 'dev_x', argv: ['git', 'status'] },
    computer_write: { machine: 'dev_x', path: '/tmp/a.txt', text: 'hi' },
    hand_to_person: { text: 'look at this' },
    make_chart: { name: 'c' },
    make_file: { name: 'n.md', text: 'hi' },
    remember: { text: 'note' },
    robot_steps: { robot: 'r1', steps: ['forward'] },
    run_tool: { tool: 'openvibe.blog.post', input: { site: 'openvibe.blog' } },
    schedule_trigger: { cron: '0 9 * * *', task: 'digest' },
    space_create: { name: 'My space' },
    space_files_write: { space_id: 'sp_1', files: [{ path: 'a.txt', content: 'x' }] },
    space_publish: { space_id: 'sp_1' },
};

(async () => {
    // ── Every acting tool has a kind ──
    await check('every acting tool is mapped to a kind, and every kind has plain words', async () => {
        const registry = createRegistry({ strict: true, log: { warn() {}, log() {} } });
        const acting = registry.tools.filter((t) => t.acts === true).map((t) => t.name).sort();
        assert.deepStrictEqual(acting, Object.keys(EXPECTED).sort(), 'every acting tool is in the list; classify a new one');
        for (const name of acting) {
            const step = stepFor(name, SAMPLE[name]);
            if (EXPECTED[name] === null) {
                assert.strictEqual(step, null, `${name}: Actor's own working state never asks`);
                continue;
            }
            assert.ok(step, `${name}: the step must say what it is`);
            assert.ok(kinds.isKind(step.kind), `${name}: ${step.kind} is a known kind`);
            assert.ok(kinds.label(step.kind).length > 3, `${name}: the kind reads as plain words`);
            assert.ok(step.summary && step.summary.length > 3, `${name}: a plain summary`);
            assert.ok(step.target && step.target.length > 1, `${name}: the exact target it would touch`);
        }
    });

    await check('the kinds cover the trust spine: computer, money, publishing, posting, sending, installing, routines', async () => {
        for (const kind of ['computer.run', 'computer.write', 'computer.input', 'computer.browser', 'money', 'publish', 'post', 'send', 'install', 'routine']) {
            assert.ok(kinds.isKind(kind), `${kind} is a kind`);
            assert.ok(kinds.label(kind), `${kind} has plain words`);
        }
        // A generic OpenVibe.Tools tool takes the kind of the tool it runs; a plain lookup still does not ask.
        assert.strictEqual(stepFor('run_tool', { tool: 'openvibe.blog.post', input: {} }).kind, 'post');
        assert.strictEqual(stepFor('run_tool', { tool: 'openvibe.tools.install_skill', input: {} }).kind, 'install');
        assert.strictEqual(stepFor('run_tool', { tool: 'openvibe.mail.send', input: {} }).kind, 'send');
        assert.strictEqual(stepFor('run_tool', { tool: 'openvibe.wallet.pay', input: {} }).kind, 'money');
        assert.strictEqual(stepFor('run_tool', { tool: 'dns.lookup', input: {} }), null, 'a lookup stays a lookup');
    });

    await check('the table accepts every kind the code can ask for', async () => {
        // The migration widens the check on the kinds column; the two lists must not drift apart.
        const dir = path.join(__dirname, '..', 'migrations');
        const file = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
            .map((f) => ({ f, sql: fs.readFileSync(path.join(dir, f), 'utf8') }))
            .filter((m) => m.sql.includes('actor_approvals_kind_check')).pop();
        assert.ok(file, 'the migration that widens the kinds is there');
        const listed = (file.sql.match(/CHECK \(kind IN \(([^)]*)\)\)/) || ['', ''])[1]
            .split(',').map((k) => k.trim().replace(/^'|'$/g, '')).filter(Boolean);
        assert.deepStrictEqual(listed, kinds.KINDS, `${file.f} and agents/kinds.js agree on the kinds`);
    });

    await check('the Action Center item carries the kind, the agent by name, and its own page', async () => {
        const item = items.approvalItem({
            id: 'apr_01JAB2C3D4E5F6G7H8J9K0MNPS', kind: 'publish', summary: 'Publish your post on openvibe.blog',
            state: 'pending', created_at: '2026-11-07T10:00:00.000Z', agent_id: 'agt_01JAB2C3D4E5F6G7H8J9K0MNPS',
        }, { agentName: 'Vibe', thread: 'Weekly digest' });
        assert.strictEqual(item.service, 'actor');
        assert.strictEqual(item.kind, 'approval');
        assert.strictEqual(item.bucket, 'waiting');
        assert.strictEqual(item.title, 'Publish your post on openvibe.blog');
        assert.match(item.summary, /publishing for others to see/, 'the kind in plain words');
        assert.match(item.summary, /Weekly digest/, 'the thread it came from');
        assert.strictEqual(item.agent, 'Vibe', 'the agent by its name, never its id');
        assert.strictEqual(item.href, 'https://openvibe.actor/me/approvals/apr_01JAB2C3D4E5F6G7H8J9K0MNPS');
    });

    // ── The engine: ask, allow always, and take it back ──
    const asked = [];
    const t = await boot({
        loop: {
            close: async () => {},
            run: async (args) => {
                // One step of each kind the task asks for: the same command, and another one.
                const step = stepFor('computer_run', { machine: 'dev_x', argv: args.task.includes('other') ? ['git', 'log'] : ['git', 'status'] });
                const ask = await args.requestApproval({ ...step });
                asked.push({ task: args.task, pending: Boolean(ask && ask.pending) });
                return { text: 'Done.', sources: [], evidence: [], model: 'fake' };
            },
        },
    });
    try {
        const ada = t.network.addUser('ada');
        const owner = `user:${ada.subject}`;
        const agent = (await contacts.create(t.ctx.s, t.config, owner, { name: 'Fixer', level: 'ask' })).row;
        const ask = (task) => t.get('/api/v1/tasks', { as: ada, json: { task, agent_id: agent.id }, headers: SAME });
        const pending = async () => (await approvals.list(t.ctx.s, owner)).filter((a) => a.state === 'pending');

        await check('a consequential step asks, and the request says what kind of act it is', async () => {
            const res = await ask('run git status on dev_x');
            assert.strictEqual(res.status, 201, res.text);
            await t.waitFor(res.json().id);
            const rows = await pending();
            assert.strictEqual(rows.length, 1, 'one request waits');
            const row = rows[0];
            assert.strictEqual(row.kind, 'computer.run');
            assert.strictEqual(row.target, 'git status on dev_x');
            assert.match(row.summary, /Run "git status" on your computer/);
            assert.strictEqual(row.agent_id, agent.id);
            // The page reads in plain words, and offers both ways to say yes.
            const page = await t.get(`/me/approvals/${row.id}`, { as: ada });
            assert.strictEqual(page.status, 200);
            assert.match(page.text, /running a program on your computer/, 'the kind in plain words');
            assert.match(page.text, /Always allow/, 'the person may allow it always');
            assert.match(page.text, /Approve and start it|Approve for a retry/);
            assert.match(page.text, /Fixer/, 'the agent by its name');
        });

        await check('approving once answers the request and leaves the agent asking next time', async () => {
            const row = (await pending())[0];
            const res = await t.get(`/me/approvals/${row.id}`, { as: ada, form: { decision: 'approve' }, headers: SAME });
            assert.strictEqual(res.status, 303);
            const after = await approvals.get(t.ctx.s, owner, row.id);
            assert.strictEqual(after.state, 'approved');
            assert.strictEqual(after.decision_scope, 'once');
            assert.strictEqual(after.decided_by, owner, 'who decided');
            assert.strictEqual((await allows.list(t.ctx.s, owner, agent.id)).length, 0, 'nothing is always allowed yet');
            // The same step asks again.
            const res2 = await ask('run git status on dev_x');
            await t.waitFor(res2.json().id);
            assert.strictEqual((await pending()).length, 1, 'it asks again');
        });

        await check('approve and always allow: the next identical ask does not ask, another target does', async () => {
            const row = (await pending())[0];
            const page = await t.get(`/me/approvals/${row.id}`, { as: ada });
            assert.match(page.text, /Always allow running a program on your computer for this agent/);
            const res = await t.get(`/me/approvals/${row.id}`, { as: ada, form: { decision: 'approve_always' }, headers: SAME });
            assert.strictEqual(res.status, 303);
            const after = await approvals.get(t.ctx.s, owner, row.id);
            assert.strictEqual(after.state, 'approved');
            assert.strictEqual(after.decision_scope, 'always');
            assert.ok(after.allow_id, 'the standing permission is named');
            const rules = await allows.list(t.ctx.s, owner, agent.id);
            assert.strictEqual(rules.length, 1);
            assert.deepStrictEqual([rules[0].kind, rules[0].target], ['computer.run', 'git status on dev_x']);

            // The same command on the same machine goes on without asking.
            const before = (await pending()).length;
            const res2 = await ask('run git status on dev_x');
            await t.waitFor(res2.json().id);
            assert.strictEqual((await pending()).length, before, 'the identical step does not ask again');
            const last = asked[asked.length - 1];
            assert.strictEqual(last.pending, false, 'the gate let it through');

            // Another command is another target: it asks.
            const res3 = await ask('run other git log on dev_x');
            await t.waitFor(res3.json().id);
            const rows = await pending();
            assert.strictEqual(rows.length, before + 1, 'a different target asks again');
            assert.strictEqual(rows[rows.length - 1].target, 'git log on dev_x');
        });

        await check('the agent\'s page lists what it may always do, with Revoke, and the decision is in its activity', async () => {
            const page = await t.get(`/me/agents/${agent.id}`, { as: ada });
            assert.strictEqual(page.status, 200);
            assert.match(page.text, /running a program on your computer · git status on dev_x/, 'the standing permission is listed');
            assert.match(page.text, /You approved it and allowed it always/, 'the decision is in the agent\'s activity');
            assert.match(page.text, /You approved it once/, 'the earlier decision is there too');
            assert.match(page.text, /Revoke/);
        });

        await check('revoking restores the ask', async () => {
            const rules = await allows.list(t.ctx.s, owner, agent.id);
            const res = await t.get(`/me/agents/${agent.id}/allows/${rules[0].id}/revoke`, { as: ada, method: 'POST', headers: SAME });
            assert.strictEqual(res.status, 303);
            assert.strictEqual((await allows.list(t.ctx.s, owner, agent.id)).length, 0, 'the permission is gone');
            const before = (await pending()).length;
            const res2 = await ask('run git status on dev_x');
            await t.waitFor(res2.json().id);
            assert.strictEqual((await pending()).length, before + 1, 'it asks again');
        });

        await check('the floor is never covered by a standing permission', async () => {
            const rows = await pending();
            const money = rows.find((r) => r.kind === 'computer.run' && r.target === 'git status on dev_x');
            assert.ok(money, 'the waiting request');
            // A deletion is a floor step: the page offers no "always allow", and the answer is refused.
            const del = await approvals.request(t.ctx.s, {
                owner, agentId: agent.id, kind: 'computer.run', summary: 'Run "rm -rf build" on your computer',
                payload: { argv: ['rm', '-rf', 'build'] }, target: 'rm -rf build on dev_x', categories: ['delete'],
            });
            const page = await t.get(`/me/approvals/${del.id}`, { as: ada });
            assert.ok(!/Always allow/.test(page.text), 'a floor step has no always-allow button');
            assert.match(page.text, /always asks \(delete\)/);
            const res = await t.get(`/me/approvals/${del.id}`, { as: ada, form: { decision: 'approve_always' }, headers: SAME });
            assert.strictEqual(res.status, 422);
            assert.match(res.text, /can never be always allowed/);
            assert.strictEqual((await allows.list(t.ctx.s, owner, agent.id)).length, 0, 'nothing was allowed');
            // And the floor asks even at full access, even with a rule for the same kind.
            const decision = await levels.decide({
                level: 'full', categories: ['money'], act: 'act', summary: 'Spend $10',
                allow: { kind: 'money', target: 'example.com', rules: [{ kind: 'money', target: 'example.com' }] },
            });
            assert.strictEqual(decision.ask, true, 'the floor asks whatever the rules say');
        });

        await check('the decision is in the person\'s feed too', async () => {
            const feed = await t.get('/console', { as: ada });
            assert.strictEqual(feed.status, 200);
            assert.match(feed.text, /You approved/, 'the person sees what they approved');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
