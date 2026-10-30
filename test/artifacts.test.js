'use strict';
// Task artifacts (Actor v2, stage V2-4): the files and charts a task makes live in Actor's own PostgreSQL, private to
// the person the task is for. The store keeps to the caps (a file, a task), names the person as owner, and answers
// the artifact { kind, name, mime, url, size } the result and the event carry. A task with no signed-in person (a
// public chat) has no store and makes no files.
const assert = require('assert');
const { createArtifactStore, findArtifact, artifactUrl, MAX_ARTIFACTS, NAME } = require('../server/runtime/artifacts');
const { createStore } = require('../server/db');
const taskStore = require('../server/tasks/store');
const { testDb } = require('./helpers/db');
const { check, done } = require('./helpers/boot');

const PERSON = 'user:usr_01JAB2C3D4E5F6G7H8J9K0MNPT';
const config = { baseUrl: 'https://openvibe.actor', artifacts: { maxFileBytes: 2048, maxTaskBytes: 3000 } };

const idOf = (artifact) => String(artifact.url || '').split('/').pop();

(async () => {
    const d = await testDb();
    const store = createStore(d.db);
    const taskId = store.newId('tsk');
    const otherTaskId = store.newId('tsk');
    const thirdTaskId = store.newId('tsk');
    await taskStore.insertTask(store, {
        id: taskId, requester: PERSON, task: 'make a chart', mode: 'balanced', budget_task: 0.05, budget_day: 0.25,
        created_at: store.iso(),
    });
    await taskStore.insertTask(store, {
        id: otherTaskId, requester: PERSON, task: 'another one', mode: 'balanced', budget_task: 0.05, budget_day: 0.25,
        created_at: store.iso(),
    });
    await taskStore.insertTask(store, {
        id: thirdTaskId, requester: PERSON, task: 'a third one', mode: 'balanced', budget_task: 0.05, budget_day: 0.25,
        created_at: store.iso(),
    });

    try {
        await check('a task with no signed-in person has no store and makes no files', async () => {
            for (const requester of [null, '', 'app:app_01JAB2C3D4E5F6G7H8J9K0MNPQ']) {
                const s = createArtifactStore({ store, config, taskId, requester });
                assert.strictEqual(s.available, false, String(requester) + ' gets no store');
                await assert.rejects(() => s.save({ name: 'a.txt', mime: 'text/plain', bytes: 'x' }), /not available/);
            }
            const noTask = createArtifactStore({ store, config, taskId: null, requester: PERSON });
            assert.strictEqual(noTask.available, false);
            const rows = await store.db.many('SELECT id FROM actor_artifacts');
            assert.strictEqual(rows.length, 0, 'nothing was written');
        });

        await check('save writes the bytes to Actor\'s own database, owned by the person', async () => {
            const s = createArtifactStore({ store, config, taskId, requester: PERSON });
            assert.strictEqual(s.available, true);
            const a = await s.save({ kind: 'chart', name: 'revenue.svg', mime: 'image/svg+xml', bytes: '<svg/>' });
            assert.deepStrictEqual(Object.keys(a).sort(), ['kind', 'mime', 'name', 'size', 'url']);
            assert.strictEqual(a.kind, 'chart');
            assert.strictEqual(a.name, 'revenue.svg');
            assert.strictEqual(a.mime, 'image/svg+xml');
            assert.strictEqual(a.size, 6);
            assert.strictEqual(a.url, `https://openvibe.actor/tasks/${taskId}/files/${idOf(a)}`);

            const row = await store.db.maybe('SELECT * FROM actor_artifacts WHERE id = $1', [idOf(a)]);
            assert.ok(row, 'the row is there');
            assert.strictEqual(row.task_id, taskId);
            assert.strictEqual(row.owner, PERSON, 'the person, with the user: prefix the other tables use');
            assert.strictEqual(row.name, 'revenue.svg');
            assert.strictEqual(row.mime, 'image/svg+xml');
            assert.strictEqual(row.size, 6);
            assert.strictEqual(Buffer.from(row.bytes).toString('utf8'), '<svg/>');
            assert.ok(row.created_at, 'the row says when it was made');

            // The artifact belongs to its task, and to nobody else's.
            const found = await findArtifact(store.db, taskId, idOf(a));
            assert.ok(found);
            assert.strictEqual(found.name, 'revenue.svg');
            assert.strictEqual(await findArtifact(store.db, otherTaskId, idOf(a)), null);
            assert.strictEqual(await findArtifact(store.db, taskId, 'art_nope'), null);
            assert.strictEqual(await findArtifact(store.db, taskId, '../../../etc/passwd'), null);
        });

        await check('the caps are kept: a file may not pass its own limit, and a task may not pass its own', async () => {
            const s = createArtifactStore({ store, config, taskId, requester: PERSON });
            await assert.rejects(() => s.save({ name: 'big.txt', mime: 'text/plain', bytes: Buffer.alloc(2049) }), /limit is 2048 bytes a file/);
            await assert.rejects(() => s.save({ name: 'a b.txt', mime: 'text/plain', bytes: 'x' }), /file name/);
            await assert.rejects(() => s.save({ name: 'a.txt', mime: 'text/plain', bytes: '' }), /cannot be empty/);
            assert.strictEqual(NAME.test('a.txt'), true);
            assert.strictEqual(NAME.test('.hidden'), false);
            const big = await s.save({ name: 'big.txt', mime: 'text/plain', bytes: Buffer.alloc(2048) });
            assert.strictEqual(big.size, 2048);
            await assert.rejects(() => s.save({ name: 'more.txt', mime: 'text/plain', bytes: Buffer.alloc(1000) }), /the limit is 3000 bytes a task/);
        });

        await check('a task may make a bounded number of files', async () => {
            const s = createArtifactStore({ store, config: { baseUrl: 'https://openvibe.actor', artifacts: { maxFileBytes: 2048, maxTaskBytes: 1024 * 1024 } }, taskId: otherTaskId, requester: PERSON });
            for (let i = 0; i < MAX_ARTIFACTS; i += 1) await s.save({ name: `f${i}.txt`, mime: 'text/plain', bytes: 'x' });
            await assert.rejects(() => s.save({ name: 'one-too-many.txt', mime: 'text/plain', bytes: 'x' }), new RegExp(`at most ${MAX_ARTIFACTS} files`));
            assert.strictEqual((await s.artifacts()).length, MAX_ARTIFACTS);
        });

        await check('an unknown kind is stored as a file, not passed through', async () => {
            const s = createArtifactStore({ store, config, taskId: thirdTaskId, requester: PERSON });
            const a = await s.save({ kind: 'executable', name: 'x.bin', mime: 'application/octet-stream', bytes: 'x' });
            assert.strictEqual(a.kind, 'file');
        });

        await check('the artifact link is Actor\'s own stable link, on the task\'s own page', async () => {
            assert.strictEqual(artifactUrl(config, taskId, 'art_x'), `https://openvibe.actor/tasks/${taskId}/files/art_x`);
            assert.strictEqual(artifactUrl({ baseUrl: 'https://openvibe.actor/' }, taskId, 'art_x'), `https://openvibe.actor/tasks/${taskId}/files/art_x`);
        });
    } finally {
        await d.close();
    }

    done();
})();
