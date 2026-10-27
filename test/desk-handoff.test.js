'use strict';
// Desks plan D4: an agent hands its person a step on its own desk (hand_to_person) and waits for them to take the desk
// and let go; a task's desk comes with a Watch link; the task page makes links to the person's own desk clickable and
// leaves every other address as text.
const assert = require('assert');
const { createOpenVibeTools } = require('../server/agents/tools');
const { createComputers } = require('../server/agents/computers');
const { createRobots } = require('../server/agents/robots');
const store = require('../server/tasks/store');
const { boot, check, done } = require('./helpers/boot');

const ME = 'usr_01M4W5JBFEG3QG9ER8W1A2K0RX';
const PC = 'dev_01M4W5JBFDG2TJ8C4FRDMCWBZ9';
const config = {
    networkInternalUrl: 'http://network.test', oauth: { clientId: 'actor', clientSecret: 'actor-secret' },
    services: { searchUrl: 'http://search.test', toolsUrl: 'http://tools.test', botUrl: 'http://bot.test', botPublicUrl: 'https://openvibe.bot' },
};
const tokens = { authHeaders: async () => ({ Authorization: 'Bearer svc-token' }) };
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake Bot whose desk turn answers the next of `turns` each time it is asked (the last one repeats). */
function botWith(turns) {
    const asked = [];
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(url);
        if (u.host === 'tools.test') return reply(200, { tools: [] });
        if (u.pathname === `/api/v1/machines/${PC}/desk-turn`) {
            asked.push(u.searchParams.get('desk'));
            const t = turns.length > 1 ? turns.shift() : turns[0];
            return reply(200, { machine_id: PC, desk: u.searchParams.get('desk'), ...t() });
        }
        if (u.pathname === `/api/v1/machines/${PC}/commands`) {
            const body = JSON.parse(init.body);
            if (body.kind === 'desk') return reply(200, { result: 'ack', data: { running: body.value.action !== 'stop', display: ':92', width: 1280, height: 800 } });
        }
        if (u.pathname === '/api/v1/machines') {
            return reply(200, { machines: [{ id: PC, name: 'desk-pc', online: true, agent_computer: true, computer: { level: 'trusted', browser: { level: 'trusted' }, desk: { level: 'trusted', window_manager: 'openbox', input: true, screen: true, named: true, max_desks: 4 } } }] });
        }
        return reply(404, { code: 'not_found' });
    };
    return { asked, fetchImpl };
}
// Network notifications (Desks plan D4): recorded, never sent from these tests.
const told = [];
const notifier = { enabled: true, needsYou: async (n) => { told.push(n); return { sent: true }; } };
const toolsFor = (bot) => createOpenVibeTools({ config, fetchImpl: bot.fetchImpl, robots: createRobots({ config, fetchImpl: bot.fetchImpl, tokens }), computers: createComputers({ config, fetchImpl: bot.fetchImpl, tokens }), notifier });

(async () => {
    await check('hand_to_person: the person takes the desk and lets go, and the agent goes on (looking again first)', async () => {
        const iso = (ago) => new Date(Date.now() - ago).toISOString();
        const bot = botWith([
            () => ({ person_driving: false, last_person_at: null }),
            () => ({ person_driving: true, last_person_at: iso(0) }),
            () => ({ person_driving: false, last_person_at: iso(100) }),
        ]);
        const t = toolsFor(bot);
        const run = t.deskRun();
        run.used.add(PC);
        const said = [];
        let asked = 0;
        const out = await t.handToPerson(ME, { machine: PC, what: 'Sign in to your Google account in the browser.' }, {
            desks: run, emit: async (e) => said.push(e), waitForPerson: (ms) => { asked = ms; return 60_000; }, pollMs: 5, quietMs: 50,
        });
        assert.strictEqual(out.done, true);
        assert.match(out.note, /Look at it again/);
        assert.strictEqual(out.watch, `https://openvibe.bot/machines/${PC}/screen?desk=${run.name}`);
        assert.ok(asked > 0, 'the task\'s clock was asked to wait');
        assert.strictEqual(said.length, 1);
        assert.strictEqual(said[0].step, 'text');
        assert.match(said[0].text, new RegExp(`^Needs you: Sign in to your Google account in the browser\\. .*https://openvibe\\.bot/machines/${PC}/screen\\?desk=${run.name}$`));
        assert.ok(bot.asked.every((d) => d === run.name), 'it watched the task\'s own desk');
        assert.deepStrictEqual(told.at(-1), { subject: ME, what: 'Sign in to your Google account in the browser.', url: out.watch }, 'the person is told wherever they are, with the link');
    });

    await check('hand_to_person: nobody takes it, the clock may not wait, or there is nothing to do', async () => {
        const never = botWith([() => ({ person_driving: false, last_person_at: null })]);
        const t = toolsFor(never);
        const run = t.deskRun();
        run.used.add(PC);
        const missed = await t.handToPerson(ME, { machine: PC, what: 'Solve the CAPTCHA.' }, { desks: run, emit: async () => {}, waitForPerson: () => 60, pollMs: 5, quietMs: 50 });
        assert.deepStrictEqual([missed.done, /did not take the desk/.test(missed.note)], [false, true]);
        const spent = await t.handToPerson(ME, { machine: PC, what: 'Solve the CAPTCHA.' }, { desks: run, emit: async () => {}, waitForPerson: () => 0 });
        assert.deepStrictEqual([spent.done, /already waited/.test(spent.note)], [false, true]);
        assert.match((await t.handToPerson(ME, { machine: PC, what: '  ' }, { desks: run })).error, /what is the step/);
        // A machine with one private desk (an older Node): the hand-off is to that desk.
        const old = await t.handToPerson(ME, { machine: PC, what: 'Sign in.' }, { desks: t.deskRun(), emit: async () => {}, waitForPerson: () => 20, pollMs: 5 });
        assert.match(old.watch, /\?desk=private$/);
    });

    await check('computer_desk start answers with the link to watch and take over the task\'s desk', async () => {
        const bot = botWith([() => ({ person_driving: false, last_person_at: null })]);
        const t = toolsFor(bot);
        const run = t.deskRun();
        const started = JSON.parse(await t.call('computer_desk', { machine: PC, action: 'start' }, { requester: `user:${ME}`, desks: run }));
        assert.strictEqual(Object.keys(started)[0], 'watch', 'the link comes first, so a clipped result keeps it');
        assert.strictEqual(started.watch, `https://openvibe.bot/machines/${PC}/screen?desk=${run.name}`);
        const stopped = JSON.parse(await t.call('computer_desk', { machine: PC, action: 'stop' }, { requester: `user:${ME}`, desks: run }));
        assert.strictEqual(stopped.watch, undefined);
    });

    const t = await boot();
    await check('the task page links the person\'s own desk, marks "Needs you", and leaves other addresses as text', async () => {
        const alice = t.network.addUser('desk-alice');
        const id = t.ctx.s.newId('tsk');
        await store.insertTask(t.ctx.s, { id, requester: `user:${alice.subject}`, task: 'Book it', mode: 'balanced', budget_task: 0.05, budget_day: 1, created_at: t.ctx.s.iso() });
        const watch = `https://openvibe.bot/machines/${PC}/screen?desk=desk-0123456789`;
        await store.appendEvent(t.ctx.s, id, { kind: 'output', step: 'plan', agent: 'openvibe-runtime', text: 'OpenVibe runtime takes it.' });
        await store.appendEvent(t.ctx.s, id, { kind: 'output', step: 'text', text: `Needs you: Sign in to the airline. Open your agent's desk, take it over, do it, then let go: ${watch}` });
        await store.appendEvent(t.ctx.s, id, { kind: 'output', step: 'text', text: `See https://evil.example/machines/${PC}/screen?desk=desk-0123456789 too` });
        const page = await t.get(`/tasks/${id}`, { as: alice });
        assert.strictEqual(page.status, 200);
        assert.ok(page.text.includes('tl-needs') && page.text.includes('Needs you'), 'the hand-off stands out');
        assert.ok(page.text.includes(`<a href="${watch.replace(/&/g, '&amp;')}" rel="noopener">your agent&#39;s desk</a>`) || page.text.includes(`<a href="${watch}" rel="noopener">your agent&#39;s desk</a>`), 'the desk link is clickable');
        assert.ok(!page.text.includes('href="https://evil.example'), 'another address stays text');
        assert.ok(page.text.includes('data-bot="https://openvibe.bot"'));
    });
    await check('the task\'s record says it needs its person while the hand-off waits, and stops saying so after', async () => {
        const bea = t.network.addUser('desk-bea');
        const id = t.ctx.s.newId('tsk');
        await store.insertTask(t.ctx.s, { id, requester: `user:${bea.subject}`, task: 'Book it', mode: 'balanced', budget_task: 0.05, budget_day: 1, created_at: t.ctx.s.iso() });
        const watch = `https://openvibe.bot/machines/${PC}/screen?desk=desk-0123456789`;
        await store.appendEvent(t.ctx.s, id, { kind: 'output', step: 'plan', agent: 'openvibe-runtime', text: 'OpenVibe runtime takes it.' });
        assert.strictEqual((await t.get(`/api/v1/tasks/${id}`, { as: bea })).json().needs_you, undefined, 'nothing waits yet');
        const e = await store.appendEvent(t.ctx.s, id, { kind: 'output', step: 'text', text: `Needs you: Sign in to the airline. Open your agent's desk, take it over, do it, then let go: ${watch}` });
        const waiting = (await t.get(`/api/v1/tasks/${id}`, { as: bea })).json();
        assert.deepStrictEqual(waiting.needs_you, { seq: e.seq, what: 'Sign in to the airline.', url: watch });
        await store.appendEvent(t.ctx.s, id, { kind: 'output', step: 'tool_result', tool: 'hand_to_person', text: '{"done":true}' });
        assert.strictEqual((await t.get(`/api/v1/tasks/${id}`, { as: bea })).json().needs_you, undefined, 'the person let go: nothing waits');
    });
    await check('a running task shows the desk it works on, to watch and take over, on its record and its page; not after the desk stops', async () => {
        const cy = t.network.addUser('desk-cy');
        const id = t.ctx.s.newId('tsk');
        await store.insertTask(t.ctx.s, { id, requester: `user:${cy.subject}`, task: 'Find a flight', mode: 'balanced', budget_task: 0.05, budget_day: 1, created_at: t.ctx.s.iso() });
        const watch = `https://openvibe.bot/machines/${PC}/screen?desk=desk-0123456789`;
        await store.appendEvent(t.ctx.s, id, { kind: 'output', step: 'plan', agent: 'openvibe-runtime', text: 'OpenVibe runtime takes it.' });
        const before = await t.get(`/tasks/${id}`, { as: cy });
        assert.ok(/<section class="desk-card" id="desk-card" aria-live="polite" hidden>/.test(before.text), 'no desk yet: the card waits, hidden');
        assert.strictEqual((await t.get(`/api/v1/tasks/${id}`, { as: cy })).json().desk, undefined);
        await store.appendEvent(t.ctx.s, id, { kind: 'output', step: 'tool_call', tool: 'computer_desk', input: `${PC}: ` });
        await store.appendEvent(t.ctx.s, id, { kind: 'output', step: 'tool_result', tool: 'computer_desk', text: JSON.stringify({ watch, running: true, kind: 'browser', width: 1280, height: 800 }) });
        assert.deepStrictEqual((await t.get(`/api/v1/tasks/${id}`, { as: cy })).json().desk, { url: watch, kind: 'browser' });
        const during = await t.get(`/tasks/${id}`, { as: cy });
        assert.ok(during.text.includes('<section class="desk-card" id="desk-card" aria-live="polite">'), 'shown');
        assert.ok(during.text.includes('Watch and take over') && during.text.includes(' (a browser)'));
        assert.ok(during.text.includes(`id="desk-link" href="${watch}"`) || during.text.includes(`id="desk-link" href="${watch.replace(/&/g, '&amp;')}"`));
        // A failed start or a model's text never makes a desk; a stop ends it.
        await store.appendEvent(t.ctx.s, id, { kind: 'output', step: 'tool_result', tool: 'computer_browser', text: JSON.stringify({ watch: 'https://evil.example/x', running: true }) });
        assert.strictEqual((await t.get(`/api/v1/tasks/${id}`, { as: cy })).json().desk.url, watch, 'only computer_desk results count');
        await store.appendEvent(t.ctx.s, id, { kind: 'output', step: 'tool_result', tool: 'computer_desk', text: JSON.stringify({ running: false }) });
        assert.strictEqual((await t.get(`/api/v1/tasks/${id}`, { as: cy })).json().desk, undefined, 'stopped');
        assert.deepStrictEqual(store.deskFrom([{ step: 'tool_result', tool: 'computer_desk', is_error: true, text: JSON.stringify({ watch, running: true }) }]), null, 'an error is no desk');
        // A finished task shows none.
        await store.appendEvent(t.ctx.s, id, { kind: 'output', step: 'tool_result', tool: 'computer_desk', text: JSON.stringify({ watch, running: true }) });
        await store.updateTask(t.ctx.s, id, { state: 'succeeded', finished_at: t.ctx.s.iso() });
        assert.strictEqual((await t.get(`/api/v1/tasks/${id}`, { as: cy })).json().desk, undefined);
        assert.ok(!(await t.get(`/tasks/${id}`, { as: cy })).text.includes('desk-card'));
    });
    await check('what the agent last saw: its last screen picture on the owner\'s task page, nowhere else, in memory only', async () => {
        const looks = require('../server/agents/looks');
        const dee = t.network.addUser('desk-dee');
        const eve = t.network.addUser('desk-eve');
        const id = t.ctx.s.newId('tsk');
        await store.insertTask(t.ctx.s, { id, requester: `user:${dee.subject}`, task: 'Check the form', mode: 'balanced', budget_task: 0.05, budget_day: 1, created_at: t.ctx.s.iso() });
        assert.strictEqual((await t.get(`/tasks/${id}/look`, { as: dee })).status, 404, 'no look yet');
        const before = await t.get(`/tasks/${id}`, { as: dee });
        assert.ok(/<figure class="last-look" id="last-look" hidden>/.test(before.text), 'the picture waits, hidden, while the task runs');
        const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
        assert.ok(looks.put(id, { format: 'jpeg', width: 1280, height: 800, content_b64: jpeg.toString('base64') }));
        const img = await t.get(`/tasks/${id}/look`, { as: dee });
        assert.strictEqual(img.status, 200);
        assert.match(img.headers['content-type'] || (img.headers.get && img.headers.get('content-type')) || '', /^image\/jpeg/);
        assert.match(img.headers['cache-control'] || (img.headers.get && img.headers.get('cache-control')) || '', /no-store/);
        assert.strictEqual((await t.get(`/tasks/${id}/look`, { as: eve })).status, 404, 'someone else never sees it');
        assert.strictEqual((await t.get(`/tasks/${id}/look`)).status, 404, 'nor someone signed out');
        const page = await t.get(`/tasks/${id}`, { as: dee });
        assert.ok(page.text.includes('<figure class="last-look" id="last-look">') && page.text.includes('width="1280" height="800"'));
        assert.ok(page.text.includes('What your agent last saw on the screen'));
        // Kept in memory for a while, then gone; never more than MAX tasks.
        assert.strictEqual(looks.get(id, Date.now() + looks.KEEP_MS + 1), null);
        assert.strictEqual(looks.put('tsk_x', { content_b64: '' }), false, 'an empty picture is not kept');
    });
    await t.close();
    done();
})();
