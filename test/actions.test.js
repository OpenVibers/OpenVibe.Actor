'use strict';
/**
 * The Action Center reads on Actor (plan 2026-10-28 §3.10, common.action-list-result@1): a first-party service with
 * actor.actions.read names one person and gets their tasks, approvals and next scheduled agent runs — never another
 * person's — mapped bucket by bucket, plain text, https links, at most 50, newest first. A person's token, a token
 * without the capability and a bad subject are refused. Actor's approval decide route (actor.approval.decide) makes
 * the same decision as /me/approvals, for its owner only, and answers the current state when decided twice.
 */
const assert = require('assert');
const crypto = require('crypto');
const { ids, serviceAuth, validate } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const items = require('../server/actions/items');

const DAY = 86_400_000;

(async () => {
    const t = await boot({ adapters: { checkers: { openai: async () => ({ text: '{"ok":true,"reason":"fine"}', cost_usd: 0 }) } } });
    try {
        const ada = t.network.addUser('ada');
        const bo = t.network.addUser('bo');
        const token = (cap, sub = 'svc:network') => {
            const now = Math.floor(Date.now() / 1000);
            return serviceAuth.signServiceToken({ iss: t.network.url, sub, actor_type: 'service', aud: ['openvibe.actor'], cap, iat: now, exp: now + 300, jti: crypto.randomUUID() }, t.network.privatePem);
        };
        const reader = token(['actor.actions.read']);
        const decider = token(['actor.approval.decide']);
        const db = t.ctx.s.db;
        const now = Date.now();
        const iso = (ms) => new Date(ms).toISOString();

        async function addTask({ requester = `user:${ada.subject}`, id = ids.newId('task'), state = 'running', text = 'Do the thing', created = now, finished = null, cost = null, error = null, result = null, agent = null, events = [] }) {
            await db.query(`INSERT INTO tasks (id, requester, task, mode, agent, budget_task, budget_day, state, cost_usd, error_detail, result, created_at, finished_at)
                VALUES ($1, $2, $3, 'balanced', $4, 0.001, 1, $5, $6, $7, $8::jsonb, $9, $10)`,
            [id, requester, text, agent, state, cost, error, result == null ? null : JSON.stringify(result), iso(created), finished ? iso(finished) : null]);
            let seq = 0;
            for (const e of events) {
                seq++;
                await db.query('INSERT INTO task_events (task_id, seq, body) VALUES ($1, $2, $3::jsonb)', [id, seq, JSON.stringify({ task_id: id, seq, kind: 'output', at: iso(created), ...e })]);
            }
            return id;
        }

        await check('the state → bucket table and the actions each bucket allows', async () => {
            const table = [
                ['queued', 'running', {}], ['running', 'running', {}], ['verifying', 'running', {}],
                ['running', 'waiting', { needsYou: true }], ['pending', 'waiting', {}],
                ['scheduled', 'scheduled', {}], ['succeeded', 'done', {}], ['approved', 'done', {}],
                ['failed', 'failed', {}], ['declined', 'failed', {}], ['cancelled', 'failed', {}], ['expired', 'failed', {}],
            ];
            for (const [state, bucket, opts] of table) assert.strictEqual(items.bucketFor(state, opts), bucket, state);
            assert.deepStrictEqual(items.actionsFor('running', { canCancel: true }), ['open', 'cancel']);
            assert.deepStrictEqual(items.actionsFor('running'), ['open']);
            assert.deepStrictEqual(items.actionsFor('waiting', { approval: true }), ['approve', 'decline', 'open']);
            assert.deepStrictEqual(items.actionsFor('waiting'), ['open']);
            assert.deepStrictEqual(items.actionsFor('failed', { canRetry: true }), ['open', 'retry']);
            assert.deepStrictEqual(items.actionsFor('failed'), ['open']);
            assert.deepStrictEqual(items.actionsFor('done'), ['open']);
            assert.strictEqual(items.plain('<b>Fix</b> **the** [bug](https://x) &amp; ship\tnow', 160), 'Fix the bug & ship now');
            assert.ok(items.plain('x'.repeat(500), 400).length <= 400);
            assert.ok(items.plain('y'.repeat(500), 160).length <= 160);
        });

        const runningOld = ids.newId('task');
        const needs = ids.newId('task');
        const succeeded = ids.newId('task');
        const failed = ids.newId('task');
        const cancelled = ids.newId('task');
        const old = ids.newId('task');
        const theirs = ids.newId('task');
        const approval = `apr_${ids.ulid()}`;
        const declined = `apr_${ids.ulid()}`;
        const oldApproval = `apr_${ids.ulid()}`;
        const theirsApproval = `apr_${ids.ulid()}`;
        const agent = ids.newId('agent');
        const paused = ids.newId('agent');
        const off = ids.newId('agent');

        await check('only that person\'s items, newest first, with the buckets, actions, text and links common.action-item@1 allows', async () => {
            await addTask({ id: runningOld, state: 'running', created: now - 40 * DAY, text: '<b>Still</b> working' });
            await addTask({ id: needs, state: 'running', text: 'Sign in for me', created: now - 3 * 3600_000, events: [{ at: iso(now - 2 * 3600_000), step: 'text', text: 'Needs you: sign in to GitHub' }] });
            await addTask({ id: succeeded, state: 'succeeded', text: '# Fixed **the** [bug](https://example.com)', created: now - 2 * DAY, finished: now - DAY, cost: 0.12, result: { answer: '<p>All **done** &amp; shipped.</p>' }, events: [{ step: 'tool_call', tool: 'read', text: 'read' }, { step: 'tool_call', tool: 'write', text: 'write' }] });
            await addTask({ id: failed, state: 'failed', text: 'Broken task', created: now - 4 * DAY, finished: now - 3 * DAY, error: '<script>it broke</script>' });
            await addTask({ id: cancelled, state: 'cancelled', text: 'Stopped task', created: now - 5 * DAY, finished: now - 4 * DAY });
            await addTask({ id: old, state: 'succeeded', text: 'Ancient', created: now - 45 * DAY, finished: now - 40 * DAY });
            await addTask({ id: theirs, requester: `user:${bo.subject}`, state: 'running', text: 'Bo\'s task' });

            await db.query(`INSERT INTO actor_approvals (id, owner, agent_id, kind, summary, payload, state, created_at, expires_at, decided_at)
                VALUES ($1,$2,$3,'codes.task','Approve the fix', $4::jsonb,'pending',$5,$6,NULL)`, [approval, `user:${ada.subject}`, agent, JSON.stringify({ task: 'Fix the **bug** in the repository' }), iso(now - 3600_000), iso(now + 6 * DAY)]);
            await db.query(`INSERT INTO actor_approvals (id, owner, agent_id, kind, summary, payload, state, created_at, expires_at, decided_at)
                VALUES ($1,$2,$3,'codes.task','Already declined', '{}'::jsonb,'declined',$4,$5,$4)`, [declined, `user:${ada.subject}`, agent, iso(now - 2 * DAY), iso(now + 5 * DAY)]);
            await db.query(`INSERT INTO actor_approvals (id, owner, agent_id, kind, summary, payload, state, created_at, expires_at, decided_at)
                VALUES ($1,$2,$3,'codes.task','Old approval', '{}'::jsonb,'approved',$4,$5,$4)`, [oldApproval, `user:${ada.subject}`, agent, iso(now - 40 * DAY), iso(now - 33 * DAY)]);
            await db.query(`INSERT INTO actor_approvals (id, owner, agent_id, kind, summary, payload, state, created_at, expires_at, decided_at)
                VALUES ($1,$2,$3,'codes.task','Bo approval', '{}'::jsonb,'pending',$4,$5,NULL)`, [theirsApproval, `user:${bo.subject}`, agent, iso(now - 3600_000), iso(now + 6 * DAY)]);

            await db.query(`INSERT INTO actor_agents (id, owner, name, instructions, mode, budget_per_run_usd, daily_runs_max, schedule, schedule_at, next_run_at, status, created_at, updated_at)
                VALUES ($1,$2,'Morning report','Summarize my day','balanced',1,1,'daily','07:00',$3,'active',$4,$4)`, [agent, `user:${ada.subject}`, iso(now + 5 * 3600_000), iso(now - 6 * DAY)]);
            await db.query(`INSERT INTO actor_agents (id, owner, name, instructions, mode, budget_per_run_usd, daily_runs_max, schedule, schedule_at, next_run_at, status, created_at, updated_at)
                VALUES ($1,$2,'Paused one','Never runs','balanced',1,1,'daily','08:00',$3,'paused',$4,$4)`, [paused, `user:${ada.subject}`, iso(now + 6 * 3600_000), iso(now - 6 * DAY)]);
            await db.query(`INSERT INTO actor_agents (id, owner, name, instructions, mode, budget_per_run_usd, daily_runs_max, schedule, schedule_at, next_run_at, status, created_at, updated_at)
                VALUES ($1,$2,'Off one','Never runs','balanced',1,1,'off',NULL,NULL,'active',$3,$3)`, [off, `user:${ada.subject}`, iso(now - 6 * DAY)]);

            const res = await t.get(`/api/v1/actions?subject=${ada.subject}`, { bearer: reader });
            assert.strictEqual(res.status, 200, res.text);
            const body = res.json();
            const v = validate('common.action-list-result@1', body);
            assert.ok(v.valid, JSON.stringify(v.errors));
            const byId = new Map(body.items.map((i) => [i.id, i]));
            assert.ok(byId.has(runningOld) && byId.get(runningOld).bucket === 'running', 'an old running task is still running');
            assert.deepStrictEqual([byId.get(needs).state, byId.get(needs).bucket, byId.get(needs).actions], ['needs_you', 'waiting', ['open']]);
            assert.deepStrictEqual([byId.get(succeeded).bucket, byId.get(succeeded).cost_usd, byId.get(succeeded).steps, byId.get(succeeded).actions], ['done', 0.12, 2, ['open']]);
            assert.strictEqual(byId.get(succeeded).title, 'Fixed the bug');
            assert.strictEqual(byId.get(succeeded).summary, 'All done & shipped.');
            assert.deepStrictEqual([byId.get(failed).bucket, byId.get(failed).error, byId.get(failed).actions], ['failed', 'it broke', ['open']]);
            assert.deepStrictEqual([byId.get(cancelled).bucket, byId.get(cancelled).actions], ['failed', ['open']]);
            assert.ok(byId.has(approval) && byId.get(approval).bucket === 'waiting', 'the pending approval waits');
            assert.deepStrictEqual(byId.get(approval).actions, ['approve', 'decline', 'open']);
            assert.strictEqual(byId.get(approval).summary, 'Fix the bug in the repository');
            assert.ok(!byId.has(declined), 'a decided approval is no longer an action waiting on the person');
            assert.deepStrictEqual([byId.get(agent).bucket, byId.get(agent).state, byId.get(agent).next_run_at], ['scheduled', 'scheduled', iso(now + 5 * 3600_000)]);
            assert.ok(!byId.has(paused) && !byId.has(off), 'paused and off agents are not scheduled');
            assert.ok(!byId.has(old) && !byId.has(oldApproval), 'done and failed tasks older than 30 days are gone');
            assert.ok(!byId.has(theirs) && !byId.has(theirsApproval), 'never another person\'s items');
            for (const it of body.items) {
                assert.match(it.href, /^https:\/\//);
                assert.ok(it.title.length <= 160 && (!it.summary || it.summary.length <= 400) && (!it.error || it.error.length <= 400));
                assert.ok(!/[<>*_`]/.test(it.title) && !/[<>*_`]/.test(it.summary || '') && !/[<>*_`]/.test(it.error || ''));
            }
            const times = body.items.map((i) => i.updated_at);
            assert.deepStrictEqual(times, [...times].sort().reverse(), 'newest updated_at first');
            assert.strictEqual(byId.get(runningOld).href, `https://openvibe.actor/tasks/${runningOld}`);
            assert.strictEqual(byId.get(approval).href, `https://openvibe.actor/me/approvals/${approval}`);
            assert.strictEqual(byId.get(agent).href, `https://openvibe.actor/me/agents/${agent}`);
        });

        await check('at most 50 items, newest first', async () => {
            const mara = t.network.addUser('mara');
            const first = ids.newId('task');
            for (let i = 0; i < 55; i++) {
                await addTask({ id: i === 0 ? first : ids.newId('task'), requester: `user:${mara.subject}`, state: 'running', text: `Task ${i}`, created: now - i * 60_000 });
            }
            const res = await t.get(`/api/v1/actions?subject=${mara.subject}`, { bearer: reader });
            assert.strictEqual(res.status, 200, res.text);
            assert.strictEqual(res.json().items.length, 50);
            assert.strictEqual(res.json().items[0].id, first, 'the newest of the 55');
        });

        await check('a person\'s token, a service without the capability and a bad subject are refused', async () => {
            const user = await t.get(`/api/v1/actions?subject=${ada.subject}`, { as: ada });
            assert.strictEqual(user.status, 403);
            const userBearer = await t.get(`/api/v1/actions?subject=${ada.subject}`, { bearer: t.network.userToken(ada) });
            assert.strictEqual(userBearer.status, 403);
            const noCap = await t.get(`/api/v1/actions?subject=${ada.subject}`, { bearer: token(['actor.task.list']) });
            assert.strictEqual(noCap.status, 403);
            const none = await t.get(`/api/v1/actions?subject=${ada.subject}`);
            assert.strictEqual(none.status, 401);
            const bad = await t.get('/api/v1/actions?subject=usr_nope', { bearer: reader });
            assert.strictEqual(bad.status, 400);
            assert.strictEqual(bad.json().code, 'subject.invalid');
            const missing = await t.get('/api/v1/actions', { bearer: reader });
            assert.strictEqual(missing.status, 400);
        });

        await check('decide approves and declines, answers current state when decided twice, and another subject is 404', async () => {
            const decide = (id, decision, subject = ada.subject) => t.get(`/api/v1/approvals/${id}/decide`, {
                method: 'POST', bearer: decider, json: { decision }, headers: { 'X-OV-Subject': subject },
            });
            const noHeader = await t.get(`/api/v1/approvals/${approval}/decide`, { method: 'POST', bearer: decider, json: { decision: 'approve' } });
            assert.strictEqual(noHeader.status, 400);
            const badDecision = await decide(approval, 'maybe');
            assert.strictEqual(badDecision.status, 422);
            const wrongOwner = await decide(approval, 'approve', bo.subject);
            assert.strictEqual(wrongOwner.status, 404);

            const approved = await decide(approval, 'approve');
            assert.strictEqual(approved.status, 200, approved.text);
            assert.strictEqual(approved.json().state, 'approved');
            assert.strictEqual(approved.json().bucket, 'done');
            assert.deepStrictEqual(approved.json().actions, ['open']);
            assert.ok(validate('common.action-item@1', approved.json()).valid);
            const row = await t.ctx.s.db.maybe('SELECT * FROM actor_approvals WHERE id = $1', [approval]);
            assert.strictEqual(row.state, 'approved');
            assert.match(row.result_task_id, /^tsk_/);
            const tasksBefore = Number(await t.ctx.s.db.value('SELECT count(*) FROM tasks WHERE requester = $1', [`user:${ada.subject}`]));
            const again = await decide(approval, 'decline');
            assert.strictEqual(again.status, 200);
            assert.strictEqual(again.json().state, 'approved', 'a second decision answers the current state');
            assert.strictEqual(Number(await t.ctx.s.db.value('SELECT count(*) FROM tasks WHERE requester = $1', [`user:${ada.subject}`])), tasksBefore, 'and starts nothing');

            const decidedDecline = await decide(declined, 'decline');
            assert.strictEqual(decidedDecline.status, 200);
            assert.strictEqual(decidedDecline.json().state, 'declined');
            assert.strictEqual(decidedDecline.json().bucket, 'failed');
            assert.strictEqual((await decide(declined, 'approve')).json().state, 'declined');

            const userToken = await t.get(`/api/v1/approvals/${declined}/decide`, { as: ada, method: 'POST', json: { decision: 'approve' }, headers: { 'sec-fetch-site': 'same-origin' } });
            assert.strictEqual(userToken.status, 403);
            const noCap = await t.get(`/api/v1/approvals/${declined}/decide`, { method: 'POST', bearer: reader, json: { decision: 'approve' }, headers: { 'X-OV-Subject': ada.subject } });
            assert.strictEqual(noCap.status, 403);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
