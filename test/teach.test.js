'use strict';
// Teach a task (plan §AD.33; the owner, 2026-11-20: "click on one of your actors and train it to do a task … you do the
// task, and it trains based off what you do … self-improvement, recursive"): the lesson opens the agent's desk, the
// person's own steps on it are recorded (typing kept only in a lesson, private text never), a vision model writes them
// up as a skill draft, and a later run that used that skill and needed the person rewrites the skill itself, with an undo.
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const store = require('../server/tasks/store');
const stills = require('../server/tasks/stills');
const personal = require('../server/agents/personal');
const skills = require('../server/skills');
const teach = require('../server/teach');
const recorder = require('../server/teach/recorder');
const draft = require('../server/teach/draft');
const improve = require('../server/teach/improve');

const SAME = { 'sec-fetch-site': 'same-origin' };
const MACHINE = 'dev_01JZ0000000000000000000000';
const DESK = `link:${MACHINE}:desk-lesson`;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const SKILL = { name: 'Post a clip to X', description: 'Use to post one of the person\'s clips to their X account.', instructions: 'You need: {clip_url}, {caption}.\n1. Open https://x.com/compose/post.\n2. Click the text box "What is happening?!" and type {caption} and {clip_url}.\n3. Click the blue Post button.\nDone when: the post shows on the profile.' };

/** A model that answers what the test says, and remembers what it was asked. */
function fakeModels(answer) {
    const asked = [];
    return {
        asked,
        async chat(req) { asked.push(req); return { text: typeof answer === 'function' ? answer(req) : answer, cost_usd: 0.002, model: 'fake/vision' }; },
    };
}

(async () => {
    const calls = [];
    const computers = {
        async still() { return { bytes: Buffer.from(PNG, 'base64'), type: 'image/png' }; },
        async screen(subject, machine, opts) { calls.push(['screen', machine, opts]); return { format: 'png', width: 640, height: 400, content_b64: PNG }; },
        async personSession() { return { done: true }; },
        async personInput(subject, token, machine, args) { calls.push(['input', machine, args]); return { done: true, action: args.action }; },
        async deskStream() { return { error: 'not used in this test' }; },
    };
    const t = await boot({ bot: { computers } });
    const s = t.ctx.s;
    const kim = t.network.addUser('kim-teacher');
    const bo = t.network.addUser('bo-other');
    const owner = `user:${kim.subject}`;
    const token = t.network.userToken(kim);
    const agent = (await personal.create(s, t.config, owner, { name: 'Poster', instructions: 'Post my clips.', mode: 'balanced', budget_per_run_usd: 0.05, daily_runs_max: 20, schedule: 'off', status: 'active' })).row;
    const event = (id, body) => store.appendEvent(s, id, { kind: 'output', at: s.iso(), ...body });
    const task = async (via = `agent:${agent.id}`, state = 'running') => {
        const id = s.newId('tsk');
        await store.insertTask(s, { id, requester: owner, via, agent_id: agent.id, task: 'x', mode: 'balanced', budget_task: 0.05, budget_day: 0.5, created_at: s.iso() });
        if (state !== 'queued') await store.updateTask(s, id, { state });
        return id;
    };
    try {
        await check('a step is the shape of one input: clicks keep where, keys say which, typing waits to be gathered', async () => {
            assert.deepStrictEqual(recorder.stepOf({ action: 'click', x: 10, y: 20, width: 640, height: 400 }), { text: 'You clicked', args: { action: 'click', x: 10, y: 20, width: 640, height: 400 } });
            assert.strictEqual(recorder.stepOf({ action: 'key', keys: 'Return' }).text, 'You pressed Enter');
            assert.strictEqual(recorder.stepOf({ action: 'scroll', dy: -3 }).text, 'You scrolled up');
            assert.strictEqual(recorder.stepOf({ action: 'type', text: 'a' }), null, 'typing is gathered, not a step per letter');
            assert.strictEqual(recorder.stepOf({ action: 'click' }), null, 'a click with no place is not a step');
            for (const secret of ['hunter22', 'p@ssw0rd!', 'kim@example.com']) assert.ok(recorder.looksSecret(secret), secret);
            for (const words of ['hello world', 'pizza', 'my new clip is up']) assert.ok(!recorder.looksSecret(words), words);
        });

        await check('in a lesson, typing is one step with its words; a password-shaped run and private typing never are; forget wipes it', async () => {
            const id = await task();
            for (const ch of 'my clip') await recorder.record(s, id, { action: 'type', text: ch }, { keep: true });
            await recorder.record(s, id, { action: 'key', keys: 'Tab' }, { keep: true });
            for (const ch of 'hunter22') await recorder.record(s, id, { action: 'type', text: ch }, { keep: true });
            await recorder.record(s, id, { action: 'click', x: 5, y: 5, width: 10, height: 10 }, { keep: true });
            for (const ch of 'call me') await recorder.record(s, id, { action: 'type', text: ch, private: true }, { keep: true, private: true });
            const got = await recorder.steps(s, id);
            assert.deepStrictEqual(got.map((x) => x.text), ['You typed 7 characters', 'You pressed Tab', 'You typed 8 private characters', 'You clicked', 'You typed 7 private characters']);
            assert.strictEqual(got[0].args.text, 'my clip');
            assert.strictEqual(got[2].args.text, null, 'a password-shaped run is never kept');
            assert.strictEqual(got[4].args.text, null, 'private typing is never kept');
            const pub = await store.eventsAfter(s, id, 0);
            assert.ok(!JSON.stringify(pub).includes('my clip'), 'the words are never in the public event body');
            await recorder.forget(s, id);
            assert.strictEqual((await recorder.steps(s, id))[0].args.text, null, 'forget wipes what they typed');
        });

        await check('on any other desk, typing is counted but never kept', async () => {
            const id = await task();
            for (const ch of 'secret words') await recorder.record(s, id, { action: 'type', text: ch });
            const [one] = await recorder.steps(s, id);
            assert.strictEqual(one.text, 'You typed 12 characters');
            assert.strictEqual(one.args.text, null);
        });

        await check('the skill writer reads the steps and the ringed pictures, and turns the answer into a draft', async () => {
            const models = fakeModels(JSON.stringify(SKILL));
            const steps = [
                { seq: 3, text: 'You clicked', args: { action: 'click', x: 320, y: 200, width: 640, height: 400 }, picture: true },
                { seq: 4, text: 'You typed 7 characters', args: { action: 'type', chars: 7, text: 'my clip' } },
                { seq: 5, text: 'You typed 8 private characters', args: { action: 'type', chars: 8, private: true, text: null } },
                { seq: 6, text: 'You pressed Enter', args: { action: 'key', keys: 'Return' } },
            ];
            const out = await draft.write({ models, what: 'Post a clip to X', steps, picture: async () => ({ mime: 'image/png', bytes: Buffer.from(PNG, 'base64'), width: 1, height: 1 }) });
            assert.ok(out.draft, out.error);
            assert.strictEqual(out.draft.name, 'Post a clip to X');
            const req = models.asked[0];
            assert.strictEqual(req.tier, 'vision');
            const text = req.messages[1].content[0].text;
            assert.match(text, /Typed "my clip"/);
            assert.match(text, /Typed 8 private characters \(a password/);
            assert.ok(!/hunter/.test(text));
            assert.ok(req.messages[1].content.some((p) => p.type === 'image_url' && /^data:image\//.test(p.image_url.url)), 'the picture they clicked on');
            assert.match(req.messages[0].content, /Never write a password/);
            const bad = await draft.write({ models: fakeModels('no json here'), what: 'x', steps, picture: async () => null });
            assert.ok(bad.error);
            assert.ok((await draft.write({ models, what: 'x', steps: [], picture: async () => null })).error, 'nothing shown, nothing written');
        });

        await check('a lesson starts as a task of that agent with only the desk tools, and its page asks the person to show it', async () => {
            assert.ok(teach.startUrl('javascript:alert(1)').error);
            assert.ok(teach.startUrl('https://u:p@x.com').error);
            assert.strictEqual(teach.startUrl('x.com/compose').url, 'https://x.com/compose');
            const page = await t.get(`/me/agents/${agent.id}`, { as: kim });
            assert.strictEqual(page.status, 200);
            assert.match(page.text, /Teach it a task/);
            assert.match(page.text, new RegExp(`action="/me/agents/${agent.id}/teach"`));
            const r = await t.get(`/me/agents/${agent.id}/teach`, { as: kim, method: 'POST', form: { what: 'Post a clip to X', url: 'https://x.com/compose/post', kind: 'browser' }, headers: SAME, redirect: 'manual' });
            assert.strictEqual(r.status, 303, r.text);
            const id = /\/tasks\/(tsk_[0-9A-Z]+)/.exec(r.headers.get('location'))[1];
            const row = await store.getTask(s, id);
            assert.strictEqual(row.via, `agent:${agent.id}`);
            assert.match(row.task, /computer_browser: action "open", machine "any", desk "private", url "https:\/\/x\.com\/compose\/post"/);
            assert.deepStrictEqual(typeof row.tools === 'string' ? JSON.parse(row.tools) : row.tools, teach.TEACH_TOOLS, 'only the desk tools');
            const lesson = await teach.session(s, id);
            assert.strictEqual(lesson.what, 'Post a clip to X');
            assert.strictEqual(lesson.desk_kind, 'browser');
            const refused = await t.get(`/me/agents/${agent.id}/teach`, { as: kim, method: 'POST', form: { what: '' }, headers: SAME });
            assert.strictEqual(refused.status, 422);
            const other = await t.get(`/me/agents/${agent.id}/teach`, { as: bo, method: 'POST', form: { what: 'steal it' }, headers: SAME });
            assert.notStrictEqual(other.status, 303, 'another person cannot teach this agent');
            await t.waitFor(id).catch(() => null);
        });

        await check('during a lesson the desk records the person: the click keeps its picture, the desk says teaching, Show it opens it', async () => {
            const id = await task();
            await s.db.query("INSERT INTO actor_teach_sessions (task_id, owner, agent_id, what, state, created_at) VALUES ($1,$2,$3,'Post a clip to X','watching',$4)", [id, owner, agent.id, s.iso()]);
            await event(id, { step: 'tool_result', tool: 'computer_desk', text: JSON.stringify({ watch: `https://openvibe.link/machines/${MACHINE}/screen?desk=desk-lesson`, running: true, kind: 'browser' }) });
            await event(id, { step: 'tool_call', tool: 'learn_from_person', call_id: 'l1', args: { machine: 'any', what: 'Post a clip to X' } });
            const chat = await t.get(`/chat/${id}`, { as: kim });
            assert.match(chat.text, /Show it how:/);
            assert.match(chat.text, /data-ct-takeover data-ct-teach>Show it</);
            const desks = (await t.get(`/api/v1/tasks/${id}/desks`, { as: kim, bearer: token, headers: SAME })).json().desks;
            assert.strictEqual(desks[0].teaching, true);
            const take = await t.get(`/api/v1/tasks/${id}/desks/${encodeURIComponent(DESK)}/take-over`, { as: kim, method: 'POST', headers: SAME });
            assert.strictEqual(take.status, 200, take.text);
            const click = await t.get(`/api/v1/tasks/${id}/desks/${encodeURIComponent(DESK)}/input`, { as: kim, bearer: token, json: { action: 'click', x: 320, y: 200, width: 640, height: 400 }, headers: SAME });
            assert.strictEqual(click.status, 200, click.text);
            for (const ch of 'hi there') await t.get(`/api/v1/tasks/${id}/desks/${encodeURIComponent(DESK)}/input`, { as: kim, bearer: token, json: { action: 'type', text: ch }, headers: SAME });
            const secret = await t.get(`/api/v1/tasks/${id}/desks/${encodeURIComponent(DESK)}/input`, { as: kim, bearer: token, json: { action: 'key', keys: 'Return' }, headers: SAME });
            assert.strictEqual(secret.status, 200);
            const forwarded = calls.filter((c) => c[0] === 'input').map((c) => c[2]);
            assert.ok(forwarded.every((a) => !('private' in a)), 'the private mark never reaches the desk');
            const got = await recorder.steps(s, id);
            assert.deepStrictEqual(got.map((x) => x.text), ['You clicked', 'You typed 8 characters', 'You pressed Enter']);
            assert.strictEqual(got[0].picture, true, 'the picture they clicked on');
            assert.strictEqual(got[1].args.text, 'hi there');
            assert.ok((await stills.list(s, id)).some((p) => p.tool === 'person'));
        });

        await check('the lesson tool waits while the person shows it and presses Done, then leaves the skill draft on the agent', async () => {
            const tool = require('../server/runtime/tools/learn_from_person');
            const driving = require('../server/agents/driving');
            const id = await task();
            await s.db.query("INSERT INTO actor_teach_sessions (task_id, owner, agent_id, what, state, created_at) VALUES ($1,$2,$3,'Post a clip to X','started',$4)", [id, owner, agent.id, s.iso()]);
            const models = fakeModels(JSON.stringify(SKILL));
            const said = [];
            let metered = 0;
            const ctx = {
                config: { ...t.config, services: { ...(t.config.services || {}), botUrl: (t.config.services && t.config.services.botUrl) || 'http://127.0.0.1:9' } },
                requester: owner, agentId: agent.id, store: s, taskId: id, models, log: { warn() {}, log() {} },
                emit: async (e) => { said.push(e); }, meter: async (usd) => { metered += usd; }, waitForPerson: (ms) => ms,
                signal: new AbortController().signal,
            };
            assert.ok(tool.available(ctx));
            const early = await tool.run({ machine: 'any', what: 'Post a clip to X' }, ctx);
            assert.ok(early.isError && /Start your desk first/.test(early.text), 'no desk, no lesson');
            await event(id, { step: 'tool_result', tool: 'computer_desk', text: JSON.stringify({ watch: `https://openvibe.link/machines/${MACHINE}/screen?desk=desk-lesson`, running: true, kind: 'browser' }) });
            const running = tool.run({ machine: 'any', what: 'Post a clip to X' }, ctx);
            const until = Date.now() + 5000;
            while (!said.some((e) => /^Needs you: Show me how/.test(e.text || '')) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
            assert.strictEqual((await teach.session(s, id)).state, 'watching');
            driving.take(id);
            await recorder.record(s, id, { action: 'click', x: 320, y: 200, width: 640, height: 400 }, { keep: true });
            for (const ch of 'first clip') await recorder.record(s, id, { action: 'type', text: ch }, { keep: true });
            await recorder.record(s, id, { action: 'key', keys: 'Return' }, { keep: true });
            driving.give(id);
            const out = await running;
            assert.strictEqual(out.data.done, true, out.text);
            assert.strictEqual(out.data.steps, 3);
            assert.ok(metered > 0, 'the model call is metered on the task');
            assert.match(models.asked[0].messages[1].content[0].text, /Typed "first clip"/);
            const proposal = await s.db.maybe('SELECT * FROM actor_agent_proposals WHERE id = $1', [out.data.proposal]);
            assert.strictEqual(proposal.source, 'teach');
            assert.strictEqual(proposal.state, 'pending');
            const lesson = await teach.session(s, id);
            assert.strictEqual(lesson.state, 'drafted');
            assert.strictEqual(lesson.proposal_id, proposal.id);
            assert.ok((await recorder.steps(s, id)).every((x) => x.args.text == null), 'what they typed is wiped once the draft is written');
            const page = await t.get(`/me/agents/${agent.id}`, { as: kim });
            assert.match(page.text, /Keep what you showed it\?/);
            assert.match(page.text, /Skill written: keep it below/);
            // Kept, a taught skill declares the host and the kind of step it showed, so the scan passes it.
            const kept = await personal.keepSkillProposal(s, owner, agent.id, proposal.id, SKILL);
            assert.ok(kept.listing, kept.error);
            assert.deepStrictEqual(kept.listing.skill.requires, { kinds: ['post'], hosts: ['x.com'] });
            assert.strictEqual(kept.listing.scan.state, 'passed');
        });

        await check('the Teach panel and the improve switch say plainly what they do; the viewer knows Show it, Done and private typing', async () => {
            const ui = require('../server/http/teach-ui');
            const panel = String(ui.panel({ id: 'agt_x', name: '<b>Poster</b>' }, [{ task_id: 'tsk_1', what: 'Post <a clip>', state: 'drafted', steps: 4, created_at: new Date().toISOString() }]));
            assert.match(panel, /Teach it a task/);
            assert.ok(!panel.includes('<b>Poster</b>') && !panel.includes('<a clip>'), 'names and lessons are escaped');
            assert.match(panel, /Skill written: keep it below · 4 steps/);
            assert.match(String(ui.improveSwitch({ id: 'agt_x', skills_improve: 'ask' })), /value="ask" aria-pressed="true"/);
            assert.match(ui.tryInput({ name: 'Post a clip', slug: 'learned-abc' }), /load_skill learned-abc/);
            const viewer = require('fs').readFileSync(require('path').join(__dirname, '../public/js/desks.js'), 'utf8');
            assert.match(viewer, /'Show it'/);
            assert.match(viewer, /'Done'/);
            assert.match(viewer, /typed\.private = true/);
            assert.match(viewer, /data-ct-viewer-private/);
        });

        // A private skill of the person's, installed on the agent, that a run loaded and then needed the person.
        const keepSkill = async () => {
            const id = await task();
            const p = await personal.addSkillProposal(s, owner, agent.id, SKILL, id, { source: 'teach', force: true });
            const kept = await personal.keepSkillProposal(s, owner, agent.id, p.id, SKILL);
            assert.ok(kept.listing, kept.error);
            return { id: kept.listing.id, slug: kept.listing.skill.slug };
        };
        const runThatNeededThem = async (listing, state = 'succeeded') => {
            const id = await task();
            await event(id, { step: 'tool_call', tool: 'load_skill', call_id: 'k1', args: { slug: listing.slug }, input: listing.slug });
            await event(id, { step: 'tool_call', tool: 'computer_browser', call_id: 'b1', args: { action: 'click', text: 'Post' }, input: 'click Post' });
            await event(id, { step: 'tool_result', tool: 'computer_browser', call_id: 'b1', is_error: true, text: 'no element shows "Post"' });
            await recorder.record(s, id, { action: 'click', x: 600, y: 40, width: 640, height: 400 });
            await store.updateTask(s, id, { state });
            return store.getTask(s, id);
        };
        const NEXT = { instructions: `${SKILL.instructions}\n4. If there is no Post button, open the Upload tab at the top right first.`, change: 'Opens the Upload tab first: the Post button was not on the compose page.' };

        await check('a run that loaded the skill and needed the person improves it at once (auto), and Undo puts it back', async () => {
            const listing = await keepSkill();
            const row = await runThatNeededThem(listing);
            const models = fakeModels(JSON.stringify(NEXT));
            const p = await improve.afterRun({ s, models, row });
            assert.ok(p, 'an improvement');
            assert.strictEqual(p.state, 'applied');
            assert.strictEqual(p.source, 'improve');
            const content = models.asked[0].messages[1].content;
            const told = typeof content === 'string' ? content : content[0].text;
            assert.match(told, /no element shows "Post"/, 'it reads where it failed');
            assert.match(told, /took over the desk/, 'and what the person did');
            const loaded = await skills.load(s, { owner, agentId: agent.id, slug: listing.slug });
            assert.match(loaded.instructions, /open the Upload tab/, 'the next run loads the new words');
            const mine = (await skills.forAgent(s, owner, agent.id)).find((k) => k.listing_id === listing.id);
            assert.strictEqual(mine.version, '1.1.0');
            assert.strictEqual(mine.own, true);
            assert.strictEqual(await improve.afterRun({ s, models, row }), null, 'once per run');
            const page = await t.get(`/me/agents/${agent.id}`, { as: kim });
            assert.match(page.text, /Opens the Upload tab first/);
            assert.match(page.text, /v1\.1\.0/);
            assert.match(page.text, /Try it now/);
            const undo = await t.get(`/me/agents/${agent.id}/suggestions/${p.id}`, { as: kim, method: 'POST', form: { decision: 'undo' }, headers: SAME, redirect: 'manual' });
            assert.strictEqual(undo.status, 303, undo.text);
            const back = await skills.load(s, { owner, agentId: agent.id, slug: listing.slug });
            assert.ok(!/Upload tab/.test(back.instructions), 'Undo puts the version before back');
        });

        await check('when the person said ask first, the improvement waits as a card they edit and keep', async () => {
            await s.db.query("UPDATE actor_agents SET skills_improve = 'ask' WHERE id = $1", [agent.id]);
            const listing = await keepSkill();
            const row = await runThatNeededThem(listing, 'failed');
            const p = await improve.afterRun({ s, models: fakeModels(JSON.stringify(NEXT)), row });
            assert.strictEqual(p.state, 'pending');
            const page = await t.get(`/me/agents/${agent.id}`, { as: kim });
            assert.match(page.text, /Update “Post a clip to X”\?/);
            const kept = await personal.keepSkillProposal(s, owner, agent.id, p.id, { ...SKILL, instructions: `${NEXT.instructions}\n5. Edited by me.` });
            assert.ok(kept.row, kept.error);
            const loaded = await skills.load(s, { owner, agentId: agent.id, slug: listing.slug });
            assert.match(loaded.instructions, /Edited by me/);
            await s.db.query("UPDATE actor_agents SET skills_improve = 'auto' WHERE id = $1", [agent.id]);
        });

        await check('a run that went well without the person, a lesson itself, and a registry skill are never rewritten', async () => {
            const listing = await keepSkill();
            const fine = await task();
            await event(fine, { step: 'tool_call', tool: 'load_skill', call_id: 'k1', args: { slug: listing.slug }, input: listing.slug });
            await store.updateTask(s, fine, { state: 'succeeded' });
            const models = fakeModels(JSON.stringify(NEXT));
            assert.strictEqual(await improve.afterRun({ s, models, row: await store.getTask(s, fine) }), null);
            const lesson = await runThatNeededThem(listing);
            await s.db.query("INSERT INTO actor_teach_sessions (task_id, owner, agent_id, what, state, created_at) VALUES ($1,$2,$3,'x','drafted',$4)", [lesson.id, owner, agent.id, s.iso()]);
            assert.strictEqual(await improve.afterRun({ s, models, row: lesson }), null);
            const notMine = await task();
            await event(notMine, { step: 'tool_call', tool: 'load_skill', call_id: 'k1', args: { slug: 'research-brief' }, input: 'research-brief' });
            await recorder.record(s, notMine, { action: 'click', x: 1, y: 1, width: 2, height: 2 });
            await store.updateTask(s, notMine, { state: 'failed' });
            assert.strictEqual(await improve.afterRun({ s, models, row: await store.getTask(s, notMine) }), null);
            assert.strictEqual(models.asked.length, 0, 'no model was asked');
        });

        await check('a run it finished with the person\'s help offers a new skill from what they showed it; a sign-in does not', async () => {
            const helpedRun = async (clicks, state = 'succeeded') => {
                const id = await task();
                await event(id, { step: 'tool_call', tool: 'computer_browser', call_id: 'b1', args: { action: 'open', url: 'https://x.com/compose/post' }, input: 'open https://x.com/compose/post' });
                await event(id, { step: 'tool_call', tool: 'hand_to_person', call_id: 'h1', args: { machine: 'any', what: 'Show me where to post' }, input: 'Show me where to post' });
                for (let i = 0; i < clicks; i++) await recorder.record(s, id, { action: 'click', x: 100 + i, y: 100, width: 640, height: 400 });
                await store.updateTask(s, id, { state });
                return store.getTask(s, id);
            };
            const models = fakeModels(JSON.stringify({ ...SKILL, name: 'Post from compose' }));
            const p = await improve.afterRun({ s, models, row: await helpedRun(3) });
            assert.ok(p, 'a draft');
            assert.strictEqual(p.source, 'helped');
            assert.strictEqual(p.state, 'pending');
            assert.match(models.asked[0].messages[1].content[0].text, /What the agent did itself on this run[\s\S]*open https:\/\/x\.com\/compose\/post/);
            assert.match(models.asked[0].messages[1].content[0].text, /What the person did, in order:/);
            const page = await t.get(`/me/agents/${agent.id}`, { as: kim });
            assert.match(page.text, /You stepped in on this run and showed it part of the job/);
            assert.strictEqual(await improve.afterRun({ s, models, row: await helpedRun(2) }), null, 'two clicks is a sign-in, not a lesson');
            assert.strictEqual(await improve.afterRun({ s, models, row: await helpedRun(5, 'failed') }), null, 'only a run that worked');
            assert.strictEqual(models.asked.length, 1);
            await personal.decide(s, owner, agent.id, p.id, 'dismiss');
        });

        await check('the improve switch and Try it are the person\'s own', async () => {
            const sw = await t.get(`/me/agents/${agent.id}/skills-improve`, { as: kim, method: 'POST', form: { mode: 'ask' }, headers: SAME, redirect: 'manual' });
            assert.strictEqual(sw.status, 303);
            assert.strictEqual((await personal.get(s, owner, agent.id)).skills_improve, 'ask');
            await t.get(`/me/agents/${agent.id}/skills-improve`, { as: kim, method: 'POST', form: { mode: 'auto' }, headers: SAME, redirect: 'manual' });
            const listing = (await skills.forAgent(s, owner, agent.id)).find((k) => k.own);
            const tried = await t.get(`/me/agents/${agent.id}/skills/${listing.listing_id}/try`, { as: kim, method: 'POST', headers: SAME, redirect: 'manual' });
            assert.strictEqual(tried.status, 303, tried.text);
            const id = /\/tasks\/(tsk_[0-9A-Z]+)/.exec(tried.headers.get('location'))[1];
            assert.match((await store.getTask(s, id)).task, new RegExp(`load_skill ${listing.slug}`));
            await t.waitFor(id).catch(() => null);
            const nope = await t.get(`/me/agents/${agent.id}/skills/skl_01JZ0000000000000000000000/try`, { as: kim, method: 'POST', headers: SAME });
            assert.strictEqual(nope.status, 404);
        });
    } finally {
        await t.close();
    }
    done();
})();
