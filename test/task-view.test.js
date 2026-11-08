'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const nginx = fs.readFileSync(path.join(__dirname, '../deploy/nginx/openvibe.actor.conf'), 'utf8');
assert.match(nginx, /log_format ovactor_safe '\$remote_addr \$request_method \$uri \$status'/);
assert.match(nginx, /location \^~ \/embed\/task\/ \{\s+error_log \/dev\/null crit;/);
const { boot } = require('./helpers/boot');
const tasks = require('../server/tasks/store');
const { createFrames } = require('../server/task-view/frames');
(async () => {
    let now = Date.now();
    const t = await boot({ now: () => now, bot: { computers: { still: async () => ({ type: 'image/png', bytes: Buffer.from('picture') }) } } });
    try {
        const me = t.network.addUser('viewer'), other = t.network.addUser('other');
        const bearer = t.network.userToken(me);
        async function task(user) {
            return tasks.insertTask(t.ctx.s, { id: t.ctx.s.newId('tsk'), requester: `user:${user.subject}`, task: '<script>private task</script>', mode: 'balanced', budget_task: 1, budget_day: 5, created_at: t.ctx.s.iso() });
        }
        const row = await task(me), second = await task(me), theirs = await task(other);
        const mint = (id, options = { bearer }) => t.get(`/api/v1/tasks/${id}/view-ticket`, { method: 'POST', ...options });
        assert.equal((await mint(theirs.id)).status, 404);
        assert.equal((await mint(row.id, { as: me })).status, 403);
        const issued = await mint(row.id);
        assert.equal(issued.status, 200);
        const u = new URL(issued.json().url), raw = u.searchParams.get('t');
        assert.match(raw, /^tvt_[A-Za-z0-9_-]{43}$/);
        assert.equal(Date.parse(issued.json().expires_at) - now, 900000);
        const p = u.pathname + u.search;
        for (let i = 0; i < 2; i++) {
            const page = await t.get(p, { cookie: 'actor_at=invalid-cookie' });
            assert.equal(page.status, 200); assert(!page.text.includes(raw));
            assert(page.text.includes('&lt;script&gt;')); assert(page.text.includes('target="_top"'));
            assert.equal(page.headers.get('cache-control'), 'no-store');
            assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
            assert.equal(page.headers.get('x-frame-options'), null);
            assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self'.*https:\/\/openvibe.network/);
            assert(!page.text.includes('navbar'));
        }
        assert.match((await t.get('/')).headers.get('content-security-policy'), /frame-ancestors 'none'/);
        assert.equal((await t.get(p.replace(row.id, second.id))).status, 403);
        assert.equal((await t.get(`/embed/task/${row.id}`)).status, 403);
        for (const action of ['cancel', 'takeover', 'giveback', 'view-ticket']) {
            assert((await t.get(`/api/v1/tasks/${row.id}/${action}`, { bearer: raw, method: 'POST' })).status >= 400);
        }
        assert.equal((await t.get(p, { method: 'POST' })).status, 405);
        await tasks.appendEvent(t.ctx.s, row.id, { kind: 'output', step: 'text', text: 'Working', at: t.ctx.s.iso() });
        await tasks.appendEvent(t.ctx.s, row.id, { kind: 'end', state: 'succeeded', at: t.ctx.s.iso() });
        await tasks.updateTask(t.ctx.s, row.id, { state: 'succeeded' });
        const events = await t.get(`${u.pathname}/events${u.search}`);
        assert.equal(events.status, 200); assert(events.text.includes('Working')); assert(events.text.includes('event: end'));
        await tasks.updateTask(t.ctx.s, row.id, { state: 'running' });
        await tasks.appendEvent(t.ctx.s, row.id, { kind: 'output', step: 'tool_result', tool: 'computer_desk', computer: { session_id: 'session1' }, at: t.ctx.s.iso() });
        const still = await t.get(`${u.pathname}/still${u.search}`);
        assert.equal(still.status, 200); assert.equal(still.text, 'picture');
        assert(!(await t.dbDump()).includes(raw)); assert(!t.logs().includes(raw));
        now += 900001;
        for (const suffix of ['', '/events', '/still']) assert.equal((await t.get(`${u.pathname}${suffix}${u.search}`)).status, 403);
        assert((await t.get(p)).text.includes('This view has expired'));
        const live = await mint(second.id);
        const liveUrl = new URL(live.json().url);
        await t.ctx.s.db.query('UPDATE task_view_tickets SET expires_at = $1 WHERE task_id = $2', [new Date(now + 350).toISOString(), second.id]);
        const response = await fetch(t.base + liveUrl.pathname + '/events' + liveUrl.search);
        const event = await tasks.appendEvent(t.ctx.s, second.id, { kind: 'output', step: 'text', text: 'Live step', at: t.ctx.s.iso() });
        t.ctx.stream.publish(second.id, event);
        const liveText = await response.text();
        assert(liveText.includes('Live step'), 'new steps arrive on the existing task stream');
        assert.equal(t.ctx.stream.status().streams, 0, 'expiry removes the stream subscription');
        const spec = (await t.get('/openapi.json')).json();
        assert(spec.paths['/api/v1/tasks/{id}/view-ticket'].post);
        let calls = 0;
        const frames = createFrames({ networkUrl: 'https://network.test', fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ nav: [{ url: 'https://openvibe.example/' }], soon: [] }) }; } });
        assert((await frames()).includes('https://openvibe.example')); await frames(); assert.equal(calls, 1);
        process.stdout.write('task-view: scope, owner, cookies, CSP, hashing, expiry, events, still and write rejection passed\n');
    } finally { await t.close(); }
})().then(() => process.exit(0), e => { process.stderr.write(String(e.stack) + '\n'); process.exit(1); });
