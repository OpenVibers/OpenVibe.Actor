'use strict';
/**
 * Conversations through the one run API (2026-11-15, the owner: "it's supposed to use the actor even when you're on
 * here … your main actor … instead of vibe character"). Network's /api/frame/runs starts a conversation with the
 * person's Actor (POST /api/v1/runs { text }), sends the next message (POST /:id/messages), stops a turn (/:id/stop),
 * and reads a whole conversation as one run: ?conversations=1 lists first turns only, ?conversation=1 reads one run
 * and every turn's steps in order, the person's own messages included.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const AGENTS = 'application/vnd.openvibe.agents.run+json';

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const lee = t.network.addUser('lee');
    // Network calls with the person's own Bearer, as /api/frame/runs does.
    const kimB = t.network.userToken(kim);
    const leeB = t.network.userToken(lee);
    // The answer, and the same words for the check before it is delivered (the stand-in model answers every call).
    const answer = (content) => { t.providers.reset(); t.providers.state.script = [{ content }, { content }, { content }, { content }]; };

    try {
        let runId = null;
        let secondTurn = null;

        await check('POST /api/v1/runs { text } starts a conversation with the person\'s Actor', async () => {
            answer('Three things shipped this week.');
            const r = await t.get('/api/v1/runs', { bearer: kimB, json: { text: 'What is new on OpenVibe this week?' }, headers: { 'idempotency-key': 'frame-start-0001' } });
            assert.strictEqual(r.status, 201, r.text);
            const run = r.json();
            assert.ok(/^tsk_/.test(run.id), run.id);
            assert.strictEqual(run.kind, 'chat');
            assert.strictEqual(run.title, 'What is new on OpenVibe this week?');
            assert.strictEqual(run.agent.product, 'actor');
            assert.ok(/^agt_/.test(run.agent.id), 'the person\'s own Actor answers');
            assert.ok(/\/chat\/tsk_/.test(run.url));
            runId = run.id;
            await t.waitFor(runId);
            const again = await t.get('/api/v1/runs', { bearer: kimB, json: { text: 'What is new on OpenVibe this week?' }, headers: { 'idempotency-key': 'frame-start-0001' } });
            assert.strictEqual(again.status, 200, 'the same key answers the same conversation');
            assert.strictEqual(again.json().id, runId);
        });

        await check('words are needed, and a skill body still reaches the skill run', async () => {
            const empty = await t.get('/api/v1/runs', { bearer: kimB, json: { text: '   ' } });
            assert.strictEqual(empty.status, 422);
            assert.strictEqual(empty.json().code, 'agents.run.start_needs_words');
            const skill = await t.get('/api/v1/runs', { bearer: kimB, json: { skill: 'no-such-skill' } });
            assert.strictEqual(skill.status, 404);
            assert.strictEqual(skill.json().code, 'actor.skill.not_found');
        });

        await check('a finished turn is the person\'s turn; the answer is the preview', async () => {
            const r = await t.get(`/api/v1/runs/${runId}?conversation=1`, { bearer: kimB, headers: { accept: AGENTS } });
            assert.strictEqual(r.status, 200, r.text);
            const run = r.json();
            assert.strictEqual(run.status, 'waiting');
            assert.deepStrictEqual(run.waiting, { for: 'message' });
            assert.strictEqual(run.preview.from, 'agent');
            assert.match(run.preview.text, /Three things shipped/);
            assert.strictEqual(run.turns, 1);
        });

        await check('POST /:id/messages adds a turn from the newest one, and the run stays one conversation', async () => {
            answer('The Rundown got episodes.');
            const r = await t.get(`/api/v1/runs/${runId}/messages`, { bearer: kimB, json: { text: 'Tell me more about the second one' } });
            assert.strictEqual(r.status, 202, r.text);
            assert.strictEqual(r.json().run.id, runId);
            const list = await t.get('/api/v1/runs?conversations=1', { bearer: kimB });
            const runs = list.json().runs;
            assert.strictEqual(runs.length, 1, 'a follow-up is not a run of its own');
            assert.strictEqual(runs[0].id, runId);
            const tasks = await t.get('/api/v1/tasks', { bearer: kimB });
            secondTurn = tasks.json().tasks.map((x) => x.id).find((id) => id !== runId);
            assert.ok(secondTurn);
            await t.waitFor(secondTurn);
            const read = (await t.get(`/api/v1/runs/${secondTurn}?conversation=1`, { bearer: kimB, headers: { accept: AGENTS } })).json();
            assert.strictEqual(read.id, runId, 'any turn reads the whole conversation');
            assert.strictEqual(read.turns, 2);
            assert.match(read.preview.text, /Rundown got episodes/);
        });

        await check('the steps are every turn in order, the person\'s messages included, on one cursor', async () => {
            const r = await t.get(`/api/v1/runs/${runId}/steps?conversation=1`, { bearer: kimB });
            assert.strictEqual(r.status, 200, r.text);
            const body = r.json();
            assert.strictEqual(body.run_id, runId);
            const said = body.steps.filter((x) => x.kind === 'message').map((x) => `${x.from}: ${x.text}`);
            assert.strictEqual(said[0], 'person: What is new on OpenVibe this week?');
            assert.ok(said.some((x) => /^agent: .*Three things shipped/.test(x)), said.join(' | '));
            const second = said.findIndex((x) => x === 'person: Tell me more about the second one');
            assert.ok(second > 0, said.join(' | '));
            assert.ok(said.slice(second).some((x) => /^agent: .*Rundown got episodes/.test(x)), said.join(' | '));
            let previous = -1;
            for (const step of body.steps) {
                assert.strictEqual(step.run_id, runId);
                assert.ok(Number.isInteger(step.seq) && step.seq > previous, `seq ${step.seq} after ${previous}`);
                previous = step.seq;
            }
            const rest = await t.get(`/api/v1/runs/${runId}/steps?conversation=1&after=${previous}`, { bearer: kimB });
            assert.deepStrictEqual(rest.json().steps, []);
            const middle = body.steps.find((x) => x.from === 'person' && x.seq > 1);
            const after = await t.get(`/api/v1/runs/${runId}/steps?conversation=1&after=${middle.seq - 1}`, { bearer: kimB });
            assert.strictEqual(after.json().steps[0].text, 'Tell me more about the second one', 'the cursor resumes mid-conversation');
        });

        await check('stop is safe on a finished turn; nobody else reads or writes the conversation', async () => {
            const stop = await t.get(`/api/v1/runs/${runId}/stop`, { bearer: kimB, method: 'POST' });
            assert.strictEqual(stop.status, 200, stop.text);
            assert.strictEqual(stop.json().id, runId);
            assert.strictEqual((await t.get(`/api/v1/runs/${runId}?conversation=1`, { bearer: leeB, headers: { accept: AGENTS } })).status, 404);
            assert.strictEqual((await t.get(`/api/v1/runs/${runId}/steps?conversation=1`, { bearer: leeB })).status, 404);
            assert.strictEqual((await t.get(`/api/v1/runs/${runId}/messages`, { bearer: leeB, json: { text: 'hi' } })).status, 404);
            assert.strictEqual((await t.get(`/api/v1/runs/${runId}/stop`, { bearer: leeB, method: 'POST' })).status, 404);
            assert.deepStrictEqual((await t.get('/api/v1/runs?conversations=1', { bearer: leeB })).json().runs, []);
        });

        await check('the plain list still lists every turn (the Dock and older readers)', async () => {
            const r = await t.get('/api/v1/runs', { bearer: kimB });
            const ids = r.json().runs.map((x) => x.id);
            assert.ok(ids.includes(runId) && ids.includes(secondTurn));
        });
    } finally {
        await t.close();
    }
    done();
})();
