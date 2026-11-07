'use strict';
/**
 * The approval inbox (agents/approvals.js, plan T17): a person's own agent, running while they are away, asks before it
 * starts a coding task on their machine — the run ends with a link and nothing reaches Codes; the request is on
 * /me/approvals for its owner only; approving starts the work as the person's own task routed to the codes agent;
 * declining runs nothing; a request decides once; a request left 7 days expires; a person's direct coding task never
 * asks; the approvals are in the person's account export.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const personal = require('../server/agents/personal');
const approvals = require('../server/agents/approvals');

const SAME = { 'sec-fetch-site': 'same-origin' };

(async () => {
    const codesCalls = [];
    const t = await boot({
        env: { ACTOR_CODES_URL: 'http://127.0.0.1:9' },
        adapters: {
            // No deepseek checker: classification is the heuristic, which reads "repository … bug" as code.
            checkers: { openai: async () => ({ text: '{"ok":true,"reason":"reports the change"}', cost_usd: 0 }) },
            run: {
                codes: async ({ task, requester, taskId }) => {
                    codesCalls.push({ task, requester, taskId });
                    return { text: '**Done on your machine** (deepseek).\n\nFixed the bug.', sources: ['https://openvibe.codes/run/tasks/tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2T1'], model: 'deepseek' };
                },
            },
        },
    });
    try {
        const ada = t.network.addUser('ada');
        const bo = t.network.addUser('bo');
        const owner = `user:${ada.subject}`;
        const agent = (await personal.create(t.ctx.s, t.config, owner, { name: 'Fixer', instructions: 'In https://github.com/ada/site fix the failing bug in the repository.', mode: 'balanced', budget_per_run_usd: 0.02, daily_runs_max: 5, schedule: 'off', status: 'active' })).row;

        let askId;
        await check('an agent run that would start a coding task asks instead, and nothing reaches Codes', async () => {
            const out = await personal.run(t.ctx, agent, 'The build broke.');
            assert.strictEqual(out.status, 201);
            const row = await t.waitFor(out.task.id);
            assert.strictEqual(row.state, 'succeeded');
            const result = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
            assert.match(result.answer, /Nothing has run: approve or decline it at https:\/\/openvibe\.actor\/me\/approvals\/apr_/);
            askId = result.approval.id;
            assert.strictEqual(codesCalls.length, 0);
            const a = await approvals.get(t.ctx.s, owner, askId);
            assert.deepStrictEqual([a.state, a.kind, a.agent_id, a.task_id], ['pending', 'codes.task', agent.id, out.task.id]);
            assert.match(a.summary, /https:\/\/github\.com\/ada\/site/);
        });

        await check('the inbox is its owner\'s: listed with a count, shown, and refused to anyone else', async () => {
            const list = await t.get('/me/approvals', { as: ada });
            assert.ok(list.text.includes(`/me/approvals/${askId}`) && list.text.includes('Waiting for you'));
            const agents = await t.get('/me/agents', { as: ada });
            assert.match(agents.text, /1 waiting/);
            const one = await t.get(`/me/approvals/${askId}`, { as: ada });
            assert.ok(one.text.includes('Approve and start it') && one.text.includes('fix the failing bug'));
            assert.strictEqual((await t.get(`/me/approvals/${askId}`, { as: bo })).status, 404);
            const theirs = await t.get(`/me/approvals/${askId}`, { as: bo, form: { decision: 'approve' }, headers: SAME });
            assert.strictEqual(theirs.status, 404);
            const cross = await t.get(`/me/approvals/${askId}`, { as: ada, form: { decision: 'approve' }, headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' } });
            assert.strictEqual(cross.status, 403);
        });

        await check('approving starts it as the person\'s own task on the codes agent, once', async () => {
            const res = await t.get(`/me/approvals/${askId}`, { as: ada, form: { decision: 'approve' }, headers: SAME });
            assert.strictEqual(res.status, 303);
            const taskId = /\/tasks\/(tsk_[0-9A-Z]{26})/.exec(res.headers.get('location'))[1];
            const row = await t.waitFor(taskId);
            assert.strictEqual(row.state, 'succeeded', JSON.stringify(row.error_detail));
            assert.strictEqual(row.requester, owner);
            assert.strictEqual(row.via, null);
            assert.strictEqual(codesCalls.length, 1);
            assert.strictEqual(codesCalls[0].taskId, taskId);
            const a = await approvals.get(t.ctx.s, owner, askId);
            assert.deepStrictEqual([a.state, a.result_task_id], ['approved', taskId]);
            const again = await t.get(`/me/approvals/${askId}`, { as: ada, form: { decision: 'approve' }, headers: SAME });
            assert.strictEqual(again.status, 409);
            assert.strictEqual(codesCalls.length, 1);
        });

        await check('declining runs nothing; a request left seven days expires', async () => {
            const d = await approvals.request(t.ctx.s, { owner, agentId: agent.id, kind: 'codes.task', summary: 'x', payload: { task: 'In https://github.com/a/b fix the bug.' } });
            const res = await t.get(`/me/approvals/${d.id}`, { as: ada, form: { decision: 'decline' }, headers: SAME });
            assert.strictEqual(res.status, 303);
            assert.strictEqual((await approvals.get(t.ctx.s, owner, d.id)).state, 'declined');
            const old = await approvals.request(t.ctx.s, { owner, agentId: agent.id, kind: 'codes.task', summary: 'y', payload: { task: 'z' } });
            await t.ctx.s.db.query('UPDATE actor_approvals SET expires_at = $2 WHERE id = $1', [old.id, '2000-01-01T00:00:00.000Z']);
            assert.strictEqual((await approvals.get(t.ctx.s, owner, old.id)).state, 'expired');
            assert.strictEqual(codesCalls.length, 1);
        });

        await check('a direct coding task at Vibe\'s ask level asks first; a full-access thread runs it', async () => {
            // The default is ask (plan §12), so a person's direct coding task is a thread of their Vibe's and asks.
            let before = codesCalls.length;
            const asked = await t.get('/api/v1/tasks', { as: ada, json: { task: 'In https://github.com/ada/site fix the bug in the repository.' }, headers: SAME });
            assert.strictEqual(asked.status, 201, asked.text);
            const askedRow = await t.waitFor(asked.json().id);
            assert.strictEqual(askedRow.state, 'succeeded');
            const askedResult = typeof askedRow.result === 'string' ? JSON.parse(askedRow.result) : askedRow.result;
            assert.match(askedResult.answer, /Nothing has run: approve or decline it at https:\/\/openvibe\.actor\/me\/approvals\/apr_/);
            assert.strictEqual(codesCalls.length, before, 'nothing reached Codes yet');
            const approved = await t.get(`/me/approvals/${askedResult.approval.id}`, { as: ada, form: { decision: 'approve' }, headers: SAME });
            assert.strictEqual(approved.status, 303);
            const ranId = /\/tasks\/(tsk_[0-9A-Z]{26})/.exec(approved.headers.get('location'))[1];
            assert.strictEqual((await t.waitFor(ranId)).state, 'succeeded');
            assert.strictEqual(codesCalls.length, before + 1, 'the approval starts it once, without asking again');

            // Full access is the level that lets an ordinary coding task run without a second approval.
            before = codesCalls.length;
            const full = await t.get('/api/v1/tasks', { as: ada, json: { task: 'In https://github.com/ada/site fix the typo in the repository.', level: 'full' }, headers: SAME });
            assert.strictEqual(full.status, 201, full.text);
            assert.strictEqual((await t.waitFor(full.json().id)).state, 'succeeded');
            assert.strictEqual(codesCalls.length, before + 1);

            // The floor is not the level's to skip: a full-access coding task that would delete something still asks.
            before = codesCalls.length;
            const deleting = await t.get('/api/v1/tasks', { as: ada, json: { task: 'In https://github.com/ada/site fix the bug in the repository by deleting the old cache file.', level: 'full' }, headers: SAME });
            assert.strictEqual(deleting.status, 201, deleting.text);
            const deleteRow = await t.waitFor(deleting.json().id);
            const deleteResult = typeof deleteRow.result === 'string' ? JSON.parse(deleteRow.result) : deleteRow.result;
            assert.match(deleteResult.answer, /Nothing has run: approve or decline it at https:\/\/openvibe\.actor\/me\/approvals\/apr_/);
            assert.strictEqual(codesCalls.length, before, 'a deletion never runs without its owner, even at full access');
        });
        await check('an approval page says the floor first, the command as one line and the agent by its name', async () => {
            const contacts = require('../server/agents/contacts');
            const owner = `user:${ada.subject}`;
            const helper = (await contacts.create(t.ctx.s, t.config, owner, { name: 'Tidy helper', level: 'ask' })).row;
            const ask = await approvals.request(t.ctx.s, { owner, agentId: helper.id, kind: 'actor.action',
                summary: 'Run "rm -rf /tmp/old build" on your computer', payload: { argv: ['rm', '-rf', '/tmp/old build'], machine: 'dev_x', cwd: '/home/ada' } });
            const one = await t.get(`/me/approvals/${ask.id}`, { as: ada });
            assert.strictEqual(one.status, 200, one.text);
            assert.match(one.text, /class="pa-caution"[^>]*>This deletes something\. It cannot be undone\./, 'the floor first, in words');
            assert.match(one.text, /On <b>dev_x<\/b>, it runs:/);
            assert.ok(one.text.includes('rm -rf &#39;/tmp/old build&#39;'), 'the command as one line, the spaced path quoted (escaped in the page)');
            assert.match(one.text, />Tidy helper<\/a>/, 'the agent by its name');
            const asked = (one.text.match(/Asked [\s\S]{0,240}/) || [''])[0];
            assert.match(asked, /title="[^"]+ UTC">(just now|[^<]* ago)</, `a time a person reads, the exact one in its title: ${asked}`);
            assert.match(one.text, /expires <time[^>]*>in [67] days</);
            const later = await approvals.request(t.ctx.s, { owner, agentId: helper.id, kind: 'actor.action', summary: 'Run "ls" on your computer', payload: { argv: ['ls'], machine: 'dev_x' } });
            await t.ctx.s.db.query("UPDATE actor_approvals SET expires_at = $2 WHERE id = $1", [later.id, new Date(Date.parse(t.ctx.s.iso()) + 6.75 * 86400000).toISOString()]);
            assert.match((await t.get(`/me/approvals/${later.id}`, { as: ada })).text, /expires <time[^>]*>in 6 days</, 'never more time than there is');
            assert.ok(one.text.includes('The exact request'), 'the details stay, after the plain words');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
