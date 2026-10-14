'use strict';
/**
 * The Console (server/http/console-pages.js, plan T17 layer 3): signed out it explains itself; signed in it shows the
 * person's running and recent tasks, what waits for them (their approvals, and approvals waiting on their own
 * computers), today's spend, their agents, their computers and robots read from OpenVibe.Bot as them, and links to the
 * services that own the rest. A slow or failing Bot never breaks the page. Only the person's own rows appear.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const store = require('../server/tasks/store');
const personal = require('../server/agents/personal');
const approvals = require('../server/agents/approvals');

(async () => {
    const asked = [];
    let botMode = 'ok';
    const bot = {
        computers: {
            enabled: true,
            mine: async (subject) => {
                asked.push(['computers', subject]);
                if (botMode === 'fail') return { error: 'Bot answered 503 for your computers' };
                return { computers: [{ id: 'dev_01M4W5JBFDG2TJ8C4FRDMCWBZ9', name: 'desk-pc', online: true, level: 'ask', can: ['terminal', 'files'], folders: ['/home/ada'], waiting_for_approval: 2 }] };
            },
        },
        robots: {
            enabled: true,
            mine: async (subject, { signal }) => {
                asked.push(['robots', subject]);
                if (botMode === 'fail') return await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
                return [{ id: 'rob_01M4W5JBFDG2TJ8C4FRDMCWBZ9', name: 'Desk rover', agent_control: true, online: true, estop: { latched: false }, battery: 0.8, panel: 'https://openvibe.bot/panel/rob_01M4W5JBFDG2TJ8C4FRDMCWBZ9' }];
            },
        },
    };
    const t = await boot({ bot });
    try {
        const ada = t.network.addUser('ada');
        const bo = t.network.addUser('bo');
        const owner = `user:${ada.subject}`;
        const task = async (who, text, state) => {
            const id = t.ctx.s.newId('tsk');
            await store.insertTask(t.ctx.s, { id, requester: who, task: text, mode: 'balanced', budget_task: 0.05, budget_day: 0.5, created_at: t.ctx.s.iso() });
            if (state !== 'queued') await store.updateTask(t.ctx.s, id, { state, ...(state === 'succeeded' ? { cost_usd: 0.0012, finished_at: t.ctx.s.iso() } : {}) });
            return id;
        };

        await check('signed out, the console says what it is and how to open it', async () => {
            const r = await t.get('/console');
            assert.strictEqual(r.status, 200);
            assert.match(r.text, /Sign in to open your console/);
            assert.ok(!asked.length, 'nothing asked of Bot for nobody');
        });

        await check('signed in: running and recent tasks, what waits, today, agents, computers, robots and the rest', async () => {
            const running = await task(owner, 'Check the certificate of example.com', 'running');
            await task(owner, 'Summarise the Node.js release notes', 'succeeded');
            await task(`user:${bo.subject}`, 'Bo\'s private task', 'running');
            await store.addSpend(t.ctx.s, owner, 0.0012);
            await approvals.request(t.ctx.s, { owner, kind: 'codes.task', summary: 'Fix the failing build in ada/site', payload: { task: 'fix it' } });
            await personal.create(t.ctx.s, t.config, owner, { name: 'Morning briefing', instructions: 'Summarise what shipped.', mode: 'balanced', budget_per_run_usd: 0.02, daily_runs_max: 1, schedule: 'daily', schedule_at: '08:00', status: 'active' });
            const r = await t.get('/console', { as: ada });
            assert.strictEqual(r.status, 200);
            const h = r.text;
            assert.match(h, /<h1>Console<\/h1>/);
            assert.match(h, /<form class="cn-command" method="post" action="\/tasks"/);
            assert.ok(h.includes(`href="/tasks/${running}"`) && h.includes('Check the certificate of example.com'));
            assert.match(h, /data-live="10"/, 'refreshes while something runs');
            assert.match(h, /Summarise the Node\.js release notes/);
            assert.ok(!h.includes('Bo&#39;s private task') && !h.includes("Bo's private task"), 'only the person\'s own tasks');
            assert.match(h, /Fix the failing build in ada\/site/);
            assert.match(h, /2 on your computers/);
            assert.match(h, /cn-count">3</, 'one approval here and two on the machine');
            assert.match(h, /Morning briefing/);
            assert.match(h, /desk-pc[\s\S]*Ask first · terminal, files/);
            assert.match(h, /Desk rover[\s\S]*battery 80%/);
            assert.match(h, /openvibe\.services\/projects/);
            assert.match(h, /Last 7 days: <b>\$0\.0012<\/b>, 2 tasks/, 'the week: what the two tasks spent today');
            assert.strictEqual((h.match(/class="cn-bar"/g) || []).length, 7);
            assert.deepStrictEqual(asked.filter((a) => a[1] !== ada.subject), [], 'Bot is asked as the person only');
        });

        await check('a failing or slow Bot leaves the rest of the page working', async () => {
            botMode = 'fail';
            const started = Date.now();
            const r = await t.get('/console', { as: ada });
            assert.strictEqual(r.status, 200);
            assert.match(r.text, /Bot answered 503 for your computers/);
            assert.match(r.text, /OpenVibe\.Bot did not answer in time/);
            assert.match(r.text, /Morning briefing/);
            assert.ok(Date.now() - started < 8000, 'bounded by the Bot timeout');
            botMode = 'ok';
        });

        await check('nothing running: no refresh; nothing waiting says so', async () => {
            const r = await t.get('/console', { as: bo });
            assert.strictEqual(r.status, 200);
            assert.match(r.text, /data-live="10"/, 'Bo has a running task');
            const cy = t.network.addUser('cy');
            const quiet = await t.get('/console', { as: cy });
            assert.doesNotMatch(quiet.text, /data-live=/);
            assert.match(quiet.text, /Nothing is running\./);
            assert.match(quiet.text, /No agent yet/);
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
