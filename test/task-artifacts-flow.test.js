'use strict';
// A task that makes a file, end to end (Actor v2, stage V2-4): the loop calls make_file, the bytes land in Actor's own
// database, the result and the live stream both name the file, the task page shows it, and the owner opens it from
// their own page. The event is actor.task-event@2; a v1-shaped event still validates as v1.
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

const SAME = { 'sec-fetch-site': 'same-origin' };
const NOTES = '# Notes\n\n- one\n- two\n';

function sseEvents(text) {
    return text.split('\n\n').map((block) => {
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (!line) return null;
        try { return JSON.parse(line.slice(6)); } catch { return null; }
    }).filter(Boolean);
}

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const saved = t.config.loop.selfReflections;

    try {
        await check('a task that makes a file shows it in the result, the stream and the page, and the owner opens it', async () => {
            t.providers.reset();
            t.config.loop.selfReflections = 0;
            t.providers.state.script = [
                {
                    content: 'Writing the notes.',
                    tool_calls: [{
                        id: 'c1', type: 'function',
                        function: { name: 'make_file', arguments: JSON.stringify({ format: 'markdown', name: 'notes.md', content: NOTES }) },
                    }],
                },
                { content: 'I wrote the notes and attached **notes.md** [E1].' },
            ];
            const created = (await t.get('/api/v1/tasks', { as: kim, json: { task: 'Write up my notes as a file' }, headers: SAME })).json();
            await t.waitFor(created.id);
            const task = (await t.get(`/api/v1/tasks/${created.id}`, { as: kim })).json();
            assert.strictEqual(task.state, 'succeeded', JSON.stringify(task.error));
            assert.strictEqual(task.result.artifacts.length, 1);
            const file = task.result.artifacts[0];
            assert.deepStrictEqual(Object.keys(file).sort(), ['kind', 'mime', 'name', 'size', 'url']);
            assert.strictEqual(file.kind, 'file');
            assert.strictEqual(file.name, 'notes.md');
            assert.strictEqual(file.mime, 'text/markdown');
            assert.strictEqual(file.size, Buffer.byteLength(NOTES));
            assert.match(file.url, new RegExp(`^https://openvibe\\.actor/tasks/${created.id}/files/art_`));

            // The bytes are in Actor's own database, owned by the person the task was for.
            const rows = await t.ctx.s.db.many('SELECT * FROM actor_artifacts WHERE task_id = $1', [created.id]);
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0].owner, `user:${kim.subject}`);
            assert.strictEqual(rows[0].name, 'notes.md');
            assert.strictEqual(Buffer.from(rows[0].bytes).toString('utf8'), NOTES);

            // The live stream carries it on the tool result that made it, as actor.task-event@2.
            const events = sseEvents((await t.get(`/api/v1/tasks/${created.id}/events`, { as: kim })).text);
            const carrying = events.filter((e) => Array.isArray(e.artifacts));
            assert.strictEqual(carrying.length, 1, 'one tool result carried the file');
            assert.strictEqual(carrying[0].step, 'tool_result');
            assert.deepStrictEqual(carrying[0].artifacts, [file]);
            assert.deepStrictEqual(contracts.validate('actor.task-event@2', carrying[0]).errors, []);
            assert.strictEqual(contracts.validate('actor.task-event@1', carrying[0]).valid, false, 'the @1 schema has no artifacts');
            for (const e of events) assert.ok(contracts.validate('actor.task-event@2', e).valid, JSON.stringify(e));

            // The task page names the file and links it.
            const page = (await t.get(`/tasks/${created.id}`, { as: kim })).text;
            assert.match(page, /notes\.md/);
            assert.match(page, new RegExp(`/tasks/${created.id}/files/art_`));

            // The owner opens it and gets their own bytes back.
            const path = new URL(file.url).pathname;
            const opened = await t.get(path, { as: kim });
            assert.strictEqual(opened.status, 200, opened.text);
            assert.strictEqual(opened.text, NOTES);
            assert.strictEqual(opened.headers.get('content-type'), 'text/markdown');
            assert.strictEqual(opened.headers.get('x-content-type-options'), 'nosniff');

            // Another person cannot open it, and cannot even see the task.
            assert.strictEqual((await t.get(path, { as: t.network.addUser('lee') })).status, 404);
        });

        await check('the file tools are offered only with a person and an artifact store', async () => {
            // A chat task runs with no requester (engine: fromChat ? null : row.requester), and the registry never offers
            // a person tool without one; a server with no store has available() false too.
            const { createRegistry } = require('../server/runtime/tools');
            const path = require('path');
            const registry = createRegistry({ dir: path.join(__dirname, '..', 'server', 'runtime', 'tools'), strict: true, log: { warn() {} } });
            const names = (ctx) => registry.definitions(ctx).map((d) => d.function.name);
            assert.ok(!names({ config: t.config, requester: null, artifacts: { available: true, maxFileBytes: 1024 } }).includes('make_file'), 'no person, no files');
            assert.ok(!names({ config: t.config, requester: 'user:usr_01JAB2C3D4E5F6G7H8J9K0MNPT', artifacts: { available: false } }).includes('make_chart'), 'no store, no charts');
            assert.ok(names({ config: t.config, requester: 'user:usr_01JAB2C3D4E5F6G7H8J9K0MNPT', artifacts: { available: true, maxFileBytes: 1024 } }).includes('make_file'), 'a person with a store gets them');
        });
    } finally {
        t.config.loop.selfReflections = saved;
        await t.close();
    }

    done();
})();
