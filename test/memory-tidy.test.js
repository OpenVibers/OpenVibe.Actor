'use strict';
/**
 * HO5 (plan track HO, wave 2): an agent's memory that consolidates itself.
 *
 * Nothing runs for a person who has not turned it on. When they have, one due-based job runs each due agent's own
 * notes through ONE model call in the batch class, and what the model says is DATA: an id from another agent or
 * another person is ignored, a note the person wrote is never touched, a merge longer than its sources is refused,
 * the night is capped, and every change can be undone for thirty days. The person sees the diary and the changes on
 * /memory and on the agent's page, and the diary and the night's history are in the account export.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const memory = require('../server/memory');
const tidy = require('../server/memory/tidy');
const personal = require('../server/agents/personal');
const accountData = require('../server/identity/account-data');

const SAME = { 'sec-fetch-site': 'same-origin' };

/** A fake model: it answers with the scripted JSON and remembers what it was asked. */
function fakeModels(script = []) {
    const calls = [];
    let turns = script;
    return {
        calls,
        setScript(next) { turns = next; calls.length = 0; },
        resolve(tier) { return { tier, provider: 'fake', model: 'fake-1', family: 'fake', available: true, reason: null }; },
        async warm() {},
        async chat(req) {
            calls.push(req);
            const turn = turns[Math.min(calls.length - 1, Math.max(0, turns.length - 1))] || {};
            return {
                message: { role: 'assistant', content: turn.text || '' }, text: turn.text || '', toolCalls: [],
                cost_usd: 0.00002, model: 'fake-1', provider: 'fake', family: 'fake',
                latency_class: req.latency || null,
            };
        },
    };
}

const json = (o) => ({ text: JSON.stringify(o) });

(async () => {
    const models = fakeModels();
    const t = await boot({ models });
    const u = t.network.addUser('tidy-person');
    const other = t.network.addUser('tidy-other');
    const own = `user:${u.subject}`;
    const otherOwn = `user:${other.subject}`;
    const ctx = t.ctx;

    /** One agent of this person, with its own notes. */
    const makeAgent = async (name = 'Helper') => (await personal.create(ctx.s, ctx.config, own, {
        name, instructions: 'Help with the day.', mode: 'balanced', budget_per_run_usd: 0.01, daily_runs_max: 1, schedule: 'off', status: 'active',
    })).row;
    const agent = await makeAgent();

    /** A note of that agent: active and written by the agent, unless said otherwise. */
    const note = async (text, { source = 'agent', status = 'active', id = null, of = agent } = {}) => {
        if (id) {
            await ctx.s.db.query('INSERT INTO actor_agent_memory (id, agent_id, owner, text, kind, origin, status, source_task, created_at, updated_at, last_used_at, uses) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$8,NULL,0)',
                [id, of.id, of.owner, text, 'fact', source, status, ctx.s.iso()]);
            return id;
        }
        const out = await memory.add(ctx.s, { owner: own, agentId: of.id, text, source, status: source === 'agent' ? status : 'active' });
        if (out.error) throw new Error(out.error);
        return out.row.id;
    };

    /** The night's model answer: a merge, a retire, a promote and a diary. */
    const answer = (ids, extra = {}) => json({
        changes: [
            { kind: 'merge', sources: [ids[0], ids[1]], text: 'The person prefers metric units.' },
            { kind: 'retire', id: ids[2], reason: 'a newer note says it' },
            { kind: 'promote', id: ids[3] },
        ],
        diary: 'I learned that the person prefers metric units. I merged two notes that said the same thing. I retired an old note and kept another close.',
        ...extra,
    });

    try {
        await check('the tidy is off by default, and a night that nobody asked for runs nothing', async () => {
            const row = await tidy.settings(ctx.s, own);
            assert.strictEqual(row.enabled, false, 'off until the person turns it on');
            const ids = [await note('I prefer metric units.'), await note('I use metric units.'), await note('Old note.'), await note('Keeps coming up.')];
            models.setScript([answer(ids)]);
            const ran = await tidy.runDue(ctx, { now: Date.now() });
            assert.deepStrictEqual(ran, [], 'no person is due');
            assert.strictEqual(models.calls.length, 0, 'no model call for a person who did not ask for it');
            const rows = await memory.forAgent(ctx.s, own, agent.id);
            assert.strictEqual(rows.length, 4, 'nothing changed');
            // The page says it is off, and offers to turn it on.
            const page = await t.get('/memory', { as: u });
            assert.strictEqual(page.status, 200);
            assert.match(page.text, /Tidy my agents' memory each night/);
            assert.match(page.text, /Turn it on/);
            assert.ok(!page.text.includes('Turn it off'), 'it is off');
        });

        await check('the person turns it on, and their next night is due (a row, not an interval)', async () => {
            const turned = await t.get('/memory/tidy', { as: u, method: 'POST', form: { enabled: '1' }, headers: SAME });
            assert.strictEqual(turned.status, 303);
            const row = await tidy.settings(ctx.s, own);
            assert.strictEqual(row.enabled, true);
            assert.ok(row.next_due_at, 'a next night is set');
            assert.strictEqual(row.next_due_at, tidy.nextNight(Date.now()));
            const page = await t.get('/memory', { as: u });
            assert.match(page.text, /Turn it off/);
            // Off again.
            const off = await t.get('/memory/tidy', { as: u, method: 'POST', form: { enabled: '0' }, headers: SAME });
            assert.strictEqual(off.status, 303);
            assert.strictEqual((await tidy.settings(ctx.s, own)).enabled, false);
            await tidy.setEnabled(ctx.s, own, true, Date.now());
        });

        await check('a night merges, retires and promotes, and writes the diary', async () => {
            const ids = [await note('I prefer metric units.'), await note('I use metric units.'), await note('The old address is Paris.'), await note('The person likes trains.')];
            models.setScript([answer(ids)]);
            // The night is due: the row says so.
            await ctx.s.db.query("UPDATE actor_memory_tidy SET next_due_at = $1 WHERE owner = $2", ['2020-01-01T00:00:00.000Z', own]);
            const ran = await tidy.runDue(ctx, { now: Date.now() });
            assert.strictEqual(ran.length, 1, 'one person was due');
            assert.strictEqual(models.calls.length, 1, 'ONE call for the night');

            // The merge: one note now, and the sources are kept and marked.
            const rows = await memory.forAgent(ctx.s, own, agent.id);
            const merged = rows.find((r) => r.text === 'The person prefers metric units.');
            assert.ok(merged, 'the merged note exists');
            assert.strictEqual(merged.status, 'active', 'and it is the note the agent reads');
            assert.strictEqual(merged.source, 'agent');
            for (const id of [ids[0], ids[1]]) {
                const src = rows.find((r) => r.id === id);
                assert.ok(src, 'the source is kept');
                assert.strictEqual(src.merged_into, merged.id, 'and marked merged_into');
                assert.strictEqual(src.status, 'archived', 'it leaves the active set');
            }
            // The retire: marked, never deleted.
            const retired = rows.find((r) => r.id === ids[2]);
            assert.ok(retired, 'the retired note is still there');
            assert.ok(retired.retired_at, 'marked retired_at');
            assert.strictEqual(retired.status, 'archived');
            // The promote: pinned, and read first.
            const promoted = rows.find((r) => r.id === ids[3]);
            assert.strictEqual(promoted.pinned, true);
            assert.strictEqual(promoted.pinned_by, 'agent');
            const forRun = await memory.forRun(ctx.s, own, agent.id);
            assert.strictEqual(forRun[0].id, promoted.id, 'a pinned note is read first');
            // The diary.
            const diaries = await tidy.diary(ctx.s, own, { agentId: agent.id });
            assert.strictEqual(diaries.length, 1);
            assert.match(diaries[0].text, /I learned that the person prefers metric units/);
            // The night's record.
            const night = await tidy.lastRun(ctx.s, own, { agentId: agent.id });
            assert.ok(night && night.night_of);
            assert.strictEqual(night.latency_class, 'batch', 'the run asked for the batch class');
        });

        await check('the call asks for the batch class, and the person pays for it', async () => {
            const call = models.calls[models.calls.length - 1];
            assert.strictEqual(call.latency, 'batch', 'the batch class, the cheapest that can wait');
            assert.strictEqual(call.subject, u.subject, 'the run is the person\'s');
            assert.ok(call.json, 'and it asks for JSON');
            assert.ok(/\[mem_/.test(call.messages[1].content), 'the notes go with their ids');
        });

        await check('an id from another agent or another person is ignored', async () => {
            const otherAgent = await makeAgent('Other helper');
            const otherNote = await note('Another agent\'s note.', { of: otherAgent });
            const foreign = await note('Another person\'s note.', { id: ctx.s.newId('mem'), of: { id: agent.id, owner: otherOwn } });
            const mine = await note('A note of mine.', { id: ctx.s.newId('mem') });
            models.setScript([json({
                changes: [
                    { kind: 'retire', id: otherNote },
                    { kind: 'retire', id: foreign },
                    { kind: 'promote', id: otherNote },
                    { kind: 'merge', sources: [otherNote, foreign], text: 'Nothing of theirs.' },
                ],
                diary: 'Nothing of theirs belongs to me.',
            })]);
            await ctx.s.db.query("UPDATE actor_memory_tidy SET next_due_at = $1 WHERE owner = $2", ['2020-01-01T00:00:00.000Z', own]);
            await tidy.runDue(ctx, { now: Date.now() });
            const theirs = await memory.forAgent(ctx.s, own, otherAgent.id);
            assert.ok(theirs.every((r) => !r.retired_at && !r.pinned), 'another agent\'s note is untouched');
            const mine2 = await memory.get(ctx.s, own, mine);
            assert.ok(mine2 && !mine2.retired_at, 'and so is the person\'s own');
            const foreignRow = await ctx.s.db.maybe('SELECT * FROM actor_agent_memory WHERE id = $1', [foreign]);
            assert.ok(foreignRow && !foreignRow.retired_at, 'another person\'s note is untouched');
        });

        await check('a note the person wrote, or pinned by hand, is never changed', async () => {
            const written = await note('I wrote this myself.', { source: 'person' });
            const pinned = await note('The agent wrote this, I pinned it.');
            await memory.pin(ctx.s, own, pinned, { by: 'person' });
            models.setScript([json({
                changes: [
                    { kind: 'retire', id: written },
                    { kind: 'retire', id: pinned },
                    { kind: 'promote', id: written },
                    { kind: 'merge', sources: [written, pinned], text: 'Neither of them.' },
                ],
                diary: 'I left the person\'s own words alone.',
            })]);
            await ctx.s.db.query("UPDATE actor_memory_tidy SET next_due_at = $1 WHERE owner = $2", ['2020-01-01T00:00:00.000Z', own]);
            await tidy.runDue(ctx, { now: Date.now() });
            const wrote = await memory.get(ctx.s, own, written);
            assert.strictEqual(wrote.status, 'active', 'a note the person wrote is untouched');
            assert.strictEqual(wrote.retired_at, null);
            assert.strictEqual(wrote.pinned, false);
            const hand = await memory.get(ctx.s, own, pinned);
            assert.strictEqual(hand.status, 'active', 'a note pinned by hand is untouched');
            assert.strictEqual(hand.retired_at, null);
            assert.strictEqual(hand.pinned_by, 'person');
        });

        await check('a merge longer than its sources together is refused', async () => {
            const a = await note('Short.');
            const b = await note('Also short.');
            models.setScript([json({
                changes: [{ kind: 'merge', sources: [a, b], text: 'x'.repeat(200) }],
                diary: 'I would have written a long note.',
            })]);
            await ctx.s.db.query("UPDATE actor_memory_tidy SET next_due_at = $1 WHERE owner = $2", ['2020-01-01T00:00:00.000Z', own]);
            await tidy.runDue(ctx, { now: Date.now() });
            const rows = await memory.forAgent(ctx.s, own, agent.id);
            assert.ok(!rows.some((r) => r.text === 'x'.repeat(200)), 'the long merge did not happen');
            assert.strictEqual((await memory.get(ctx.s, own, a)).status, 'active', 'and the sources are as they were');
        });

        await check('the night is capped at twenty changes', async () => {
            // Its own agent, so the count is the night's alone.
            const capped = await makeAgent('Capped helper');
            const ids = [];
            for (let i = 0; i < 25; i++) ids.push(await note(`Note number ${i} about trains.`, { of: capped }));
            models.setScript([json({
                changes: ids.map((id) => ({ kind: 'promote', id })),
                diary: 'I pinned what kept coming up.',
            })]);
            await ctx.s.db.query("UPDATE actor_memory_tidy SET next_due_at = $1 WHERE owner = $2", ['2020-01-01T00:00:00.000Z', own]);
            await tidy.runDue(ctx, { now: Date.now() });
            const rows = await memory.forAgent(ctx.s, own, capped.id);
            const pinned = rows.filter((r) => r.pinned);
            assert.strictEqual(pinned.length, tidy.MAX_CHANGES, 'at most twenty changes a night');
            const changes = await tidy.changes(ctx.s, own, { agentId: capped.id, limit: 100 });
            assert.strictEqual(changes.length, tidy.MAX_CHANGES, 'and the rest are refused');
        });

        await check('undo puts the sources back and drops the merged note', async () => {
            const a = await note('I prefer Celsius.');
            const b = await note('The temperature is Celsius.');
            models.setScript([json({
                changes: [{ kind: 'merge', sources: [a, b], text: 'The person prefers Celsius.' }],
                diary: 'I merged two notes about the temperature.',
            })]);
            await ctx.s.db.query("UPDATE actor_memory_tidy SET next_due_at = $1 WHERE owner = $2", ['2020-01-01T00:00:00.000Z', own]);
            await tidy.runDue(ctx, { now: Date.now() });
            const merged = (await memory.forAgent(ctx.s, own, agent.id)).find((r) => r.text === 'The person prefers Celsius.');
            assert.ok(merged, 'the merged note is there');
            const change = (await tidy.changes(ctx.s, own, { limit: 50 })).find((c) => c.kind === 'merge' && c.result_id === merged.id);
            assert.ok(change, 'the change is a row the person can undo');
            const undone = await tidy.undo(ctx.s, own, change.id, { now: Date.now() });
            assert.ok(!undone.error, undone.error || '');
            assert.strictEqual(await memory.get(ctx.s, own, merged.id), null, 'the merged note is gone');
            for (const id of [a, b]) {
                const src = await memory.get(ctx.s, own, id);
                assert.strictEqual(src.status, 'active', 'the source is back');
                assert.strictEqual(src.merged_into, null);
            }
            const again = await tidy.undo(ctx.s, own, change.id, { now: Date.now() });
            assert.strictEqual(again.status, 409, 'an undo happens once');
        });

        await check('an undo older than thirty days is refused', async () => {
            const change = (await tidy.changes(ctx.s, own, { limit: 100 })).find((c) => !c.undone_at);
            assert.ok(change, 'a change that was not undone yet');
            const old = Date.now() - (tidy.UNDO_DAYS + 1) * 86_400_000;
            await ctx.s.db.query('UPDATE actor_memory_changes SET created_at = $1 WHERE id = $2', [new Date(old).toISOString(), change.id]);
            const out = await tidy.undo(ctx.s, own, change.id, { now: Date.now() });
            assert.strictEqual(out.status, 409);
            assert.match(out.error, /older than 30 days/);
        });

        await check('the job is due-based: a person whose night is in the future is left alone', async () => {
            const later = t.network.addUser('tidy-later');
            const laterOwn = `user:${later.subject}`;
            await tidy.setEnabled(ctx.s, laterOwn, true, Date.now());
            models.setScript([json({ changes: [], diary: 'Nothing to do.' })]);
            const ran = await tidy.runDue(ctx, { now: Date.now() });
            assert.ok(!ran.some((r) => r.owner === laterOwn), 'their night is not due yet');
            assert.strictEqual(models.calls.length, 0, 'no call for a night in the future');
            // When it comes, it runs.
            await ctx.s.db.query("UPDATE actor_memory_tidy SET next_due_at = $1 WHERE owner = $2", ['2020-01-01T00:00:00.000Z', laterOwn]);
            const after = await tidy.runDue(ctx, { now: Date.now() });
            assert.ok(after.some((r) => r.owner === laterOwn), 'now it is due');
        });

        await check('the diary and the changes are on /memory and on the agent\'s page, with Undo', async () => {
            const page = await t.get('/memory', { as: u });
            assert.strictEqual(page.status, 200);
            assert.match(page.text, /Your agents' diaries/);
            assert.match(page.text, /What the last nights changed/);
            assert.match(page.text, /action="\/memory\/changes\/[A-Za-z0-9_]+\/undo"/, 'the undo');
            const agentPage = await t.get(`/me/agents/${agent.id}`, { as: u });
            assert.strictEqual(agentPage.status, 200);
            assert.match(agentPage.text, /Its diary/);
            assert.match(agentPage.text, /What its nights changed/);
        });

        await check('the person may edit or delete a diary entry', async () => {
            const entry = (await tidy.diary(ctx.s, own, { limit: 5 }))[0];
            const edited = await t.get(`/memory/diary/${entry.id}/edit`, { as: u, method: 'POST', form: { text: 'I learned that the person likes trains.' }, headers: SAME });
            assert.strictEqual(edited.status, 303);
            const rows = await tidy.diary(ctx.s, own, { limit: 5 });
            assert.ok(rows.some((r) => r.id === entry.id && /likes trains/.test(r.text)), 'the entry is the person\'s now');
            const deleted = await t.get(`/memory/diary/${entry.id}/delete`, { as: u, method: 'POST', form: {}, headers: SAME });
            assert.strictEqual(deleted.status, 303);
            assert.ok(!(await tidy.diary(ctx.s, own, { limit: 50 })).some((r) => r.id === entry.id), 'and it is gone');
        });

        await check('the person may pin a note by hand, and the tidy leaves it alone', async () => {
            const id = await note('The agent wrote this.');
            const pinned = await t.get(`/memory/${id}/pin`, { as: u, method: 'POST', form: {}, headers: SAME });
            assert.strictEqual(pinned.status, 303);
            const row = await memory.get(ctx.s, own, id);
            assert.strictEqual(row.pinned, true);
            assert.strictEqual(row.pinned_by, 'person');
        });

        await check('the diary and the history of the nights are in the export, and go with the account', async () => {
            const handle = accountData.create({ db: ctx.s.db, log: console });
            const part = await handle.exportPart(u.subject);
            const names = part.files.map((f) => f.name);
            assert.ok(names.includes('agent-diary.json'), 'the diary is in the export');
            assert.ok(names.includes('agent-memory-nights.json'), 'and the history of the nights');
            assert.ok(names.includes('agent-memory-changes.json'));
            assert.ok(names.includes('agent-memory-tidy.json'), 'and the consent');
            const diary = part.files.find((f) => f.name === 'agent-diary.json');
            assert.ok(diary.content.every((r) => r.owner === own), 'only this person\'s rows');
            const erased = await handle.erase([u.subject]);
            assert.ok(Number(erased.erased.actor_memory_diary) >= 1, 'the diary goes with the account');
            assert.ok(Number(erased.erased.actor_memory_changes) >= 1);
            assert.strictEqual((await tidy.diary(ctx.s, own, { limit: 50 })).length, 0);
        });

        await check('a drill starts nothing, and a test starts nothing', async () => {
            assert.deepStrictEqual(tidy.startJobs({ config: { drill: true, nodeEnv: 'production' }, s: ctx.s }), [], 'a drill starts no job');
            assert.deepStrictEqual(tidy.startJobs({ config: { drill: false, nodeEnv: 'test' }, s: ctx.s }), [], 'a test starts no job');
            assert.strictEqual(tidy.startJobs({ config: { drill: false, nodeEnv: 'production' }, s: ctx.s }).length, 1, 'otherwise the job is there');
        });
    } finally {
        await t.close();
    }

    done();
})();
