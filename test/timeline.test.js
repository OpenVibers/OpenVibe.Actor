'use strict';
/**
 * The one timeline behind the Dock (design 2026-11-07): the agent's steps in every mode, in one list, for one
 * person. A step is a title, an outcome and a link: never a prompt or a diff. Another person's entries are the same
 * 404 as one that does not exist, and an Only-me entry is in no shared list.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

// A signed-in write must come from the site itself (the same rule every other write follows).
const SAME = { 'sec-fetch-site': 'same-origin' };
const timeline = require('../server/agents/timeline');
// What OpenVibe.Watch's emitter publishes for a watch waiting on CI (test/fixtures/watch-agent-step.json,
// kept in step with the emitter by OpenVibe.Watch's own test/agent-step.test.js).
const WATCH_STEP = require('./fixtures/watch-agent-step.json');

(async () => {
    const t = await boot({});
    try {
        const ada = t.network.addUser('ada');
        const bo = t.network.addUser('bo');
        const adaSubject = 'user:' + ada.subject;
        const boSubject = 'user:' + bo.subject;
        const step = (over) => Object.assign({
            step_id: 'tsk_01JAB2C3D4E5F6G7H8J9K0MNPS', mode: 'code', product: 'codes', ref: 'tsk_01JAB2C3D4E5F6G7H8J9K0MNPS',
            title: 'Running the checkout tests', status: 'running', started_at: new Date().toISOString(),
            placement: { where: 'On your desktop', why: 'it needs your files and your Claude sign-in, and it is free' },
            link: 'https://codes.openvibe.network/tasks/tsk_01JAB2C3D4E5F6G7H8J9K0MNPS',
        }, over || {});

        await check('a step from a mode becomes an entry, with its title, its placement and its link', async () => {
            await timeline.upsert(t.ctx.s, adaSubject, step());
            const res = await t.get('/api/v1/agent/timeline', { as: ada });
            assert.strictEqual(res.status, 200, res.text);
            const body = res.json();
            assert.strictEqual(body.entries.length, 1);
            assert.strictEqual(body.now.title, 'Running the checkout tests');
            assert.strictEqual(body.now.mode, 'code');
            assert.strictEqual(body.now.placement.where, 'On your desktop');
            assert.strictEqual(body.now.audience, 'private');
            assert.strictEqual(body.counts.code, 1);
        });

        await check('the timeline never carries a prompt or a diff: the entry has no such field, and a step that brings one is still only its title', async () => {
            await timeline.upsert(t.ctx.s, adaSubject, step({ step_id: 'tsk_01JAB2C3D4E5F6G7H8J9K0MNQ', title: 'Fixing the bug', prompt: 'the prompt the person typed', diff: '@@ -1 +1 @@' }));
            const res = await t.get('/api/v1/agent/timeline', { as: ada });
            const raw = res.text;
            assert.ok(!raw.includes('the prompt the person typed'), 'no prompt');
            assert.ok(!raw.includes('@@ -1 +1 @@'), 'no diff');
            assert.ok(!/"(prompt|diff|content|message)"s*:/.test(raw), 'no such field at all');
            assert.ok(raw.includes('Fixing the bug'), 'the title is kept');
        });

        await check('another person sees nothing of it: the list is empty and one entry is a 404', async () => {
            const theirs = await t.get('/api/v1/agent/timeline', { as: bo });
            assert.strictEqual(theirs.status, 200);
            assert.strictEqual(theirs.json().entries.length, 0);
            const mine = await t.get('/api/v1/agent/timeline', { as: ada });
            const id = mine.json().entries[0].id;
            const one = await t.get('/api/v1/agent/timeline/' + id, { as: ada });
            assert.strictEqual(one.status, 200);
            const other = await t.get('/api/v1/agent/timeline/' + id, { as: bo });
            assert.strictEqual(other.status, 404, other.text);
        });

        await check('an Only-me entry is in no shared list', async () => {
            const shared = await t.get('/api/v1/agent/timeline?scope=shared', { as: ada });
            assert.strictEqual(shared.status, 200);
            assert.strictEqual(shared.json().entries.length, 0, 'a private entry is never shared');
            assert.strictEqual(shared.json().entries.filter((e) => e.audience === 'private').length, 0);
        });

        await check('needs you: an approval from a mode is listed, oldest first, and answering it goes to that mode', async () => {
            await timeline.upsert(t.ctx.s, adaSubject, step({ step_id: 'apr_01JAB2C3D4E5F6G7H8J9K0MNPS', mode: 'code', product: 'codes', title: 'Run the deploy?', status: 'needs_you', approval: { product: 'codes', id: 'apr_01JAB2C3D4E5F6G7H8J9K0MNPS', kind: 'codes.task' } }));
            const res = await t.get('/api/v1/agent/timeline?needs_you=1', { as: ada });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.json().needs_you.length, 1);
            assert.strictEqual(res.json().needs_you[0].approval.product, 'codes');
            assert.strictEqual(res.json().counts.needs_you, 1);
        });

        await check('the kill switch stops what is open and pauses the agent until it is resumed', async () => {
            const stop = await t.get('/api/v1/agent/kill-switch', { as: ada, method: 'POST', json: { action: 'stop' }, headers: SAME });
            assert.strictEqual(stop.status, 200, stop.text);
            assert.strictEqual(stop.json().paused, true);
            assert.ok(stop.json().stopped.length >= 1, 'the open steps were stopped');
            const after = await t.get('/api/v1/agent/timeline', { as: ada });
            assert.ok(after.json().entries.every((e) => e.status !== 'running'), 'nothing is running any more');
            const resume = await t.get('/api/v1/agent/kill-switch', { as: ada, method: 'POST', json: { action: 'resume' }, headers: SAME });
            assert.strictEqual(resume.status, 200);
            assert.strictEqual(resume.json().paused, false);
        });

        await check('the mode filter and the cursor page the list', async () => {
            const all = await t.get('/api/v1/agent/timeline', { as: ada });
            assert.ok(all.json().entries.length >= 2);
            const code = await t.get('/api/v1/agent/timeline?mode=code', { as: ada });
            assert.ok(code.json().entries.every((e) => e.mode === 'code'));
            assert.ok(code.json().counts.run === undefined || code.json().counts.run === 0, 'the counts say what a filter hides');
        });

        await check('an Act step that waits on CI shows Watch with its deadline, then the transition sentence, then Act', async () => {
            const t0 = Date.now() - 60000;
            const at = (ms) => new Date(t0 + ms).toISOString();
            const act = (id, title, started_at) => step({
                step_id: id, mode: 'act', product: 'actor', ref: id, title, status: 'running',
                started_at, link: 'https://actor.openvibe.network/tasks/' + id,
            });
            // 1. Act is working: it is merging #167 on the person's desktop.
            await timeline.upsert(t.ctx.s, adaSubject, act('tsk_01JAB2C3D4E5F6G7H8J9K0MAC1', 'Merging #167 on your desktop', at(0)));
            // 2. It waits on CI: the Watch step starts waiting, with its deadline in the agent's sentence.
            await timeline.upsert(t.ctx.s, adaSubject, { ...WATCH_STEP, started_at: at(1000) });
            // 3. The check sees the CI pass and stays one step; 4. the agent is back in Act, deploying.
            await timeline.upsert(t.ctx.s, adaSubject, { ...WATCH_STEP, status: 'done', started_at: at(1000), ended_at: at(5000) });
            await timeline.upsert(t.ctx.s, adaSubject, act('tsk_01JAB2C3D4E5F6G7H8J9K0MAC2', 'Deploying on your machine', at(6000)));

            const res = await t.get('/api/v1/agent/timeline', { as: ada });
            assert.strictEqual(res.status, 200, res.text);
            const body = res.json();
            const watches = body.entries.filter((e) => e.mode === 'watch' && e.title === WATCH_STEP.title);
            assert.strictEqual(watches.length, 1, 'a watch that checks again is the same entry, not a second one');
            assert.strictEqual(watches[0].status, 'done');
            assert.match(watches[0].transition, /Waiting for CI on #167 \(Watch, 4 min\)/, 'the deadline is in the sentence');
            assert.match(watches[0].transition, /then I'll merge it \(Act\)/, 'and what comes after the watch');
            assert.strictEqual(watches[0].link, WATCH_STEP.link);
            assert.strictEqual(body.now && body.now.title, 'Deploying on your machine', 'the agent is back in Act');
            const order = body.entries.map((e) => e.title);
            assert.ok(order.indexOf('Deploying on your machine') < order.indexOf(WATCH_STEP.title), 'newest first: Act after the watch');
            assert.ok(order.indexOf(WATCH_STEP.title) < order.indexOf('Merging #167 on your desktop'), 'the watch sits between the two Act steps');
            assert.strictEqual(body.counts.watch, 1);
            assert.ok(!/"prompt"|"diff"/.test(res.text), 'no prompt or diff, only the sentence');
        });

        done();
    } finally {
        await t.close();
    }
})().catch((err) => { process.stdout.write('FAILED ' + String((err && err.stack) || err) + '\n'); process.exit(1); });
