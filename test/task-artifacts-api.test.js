'use strict';
// GET /tasks/:id/files/:artifact (Actor v2, stage V2-4): the owner's own bytes, out of Actor's own database, on the
// task's own page. The task's own auth decides who may open it: another person gets the same 404 as a task that does
// not exist. An SVG is served as image/svg+xml, in a sandbox with nothing allowed to load, never sniffed, and as a
// download; only a raster image is shown in place.
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { createArtifactStore } = require('../server/runtime/artifacts');
const taskStore = require('../server/tasks/store');

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

async function makeTask(t, requester, text = 'make a chart') {
    const id = t.ctx.s.newId('tsk');
    await taskStore.insertTask(t.ctx.s, {
        id, requester, task: text, mode: 'balanced', budget_task: 0.05, budget_day: 0.25, created_at: t.ctx.s.iso(),
    });
    return id;
}

const idOf = (artifact) => String(artifact.url || '').split('/').pop();

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const lee = t.network.addUser('lee');
    const owner = `user:${kim.subject}`;

    try {
        await check('the owner opens their own file, and it is served as it is', async () => {
            const id = await makeTask(t, owner);
            const store = createArtifactStore({ store: t.ctx.s, config: t.config, taskId: id, requester: owner });
            const file = await store.save({ kind: 'chart', name: 'revenue.svg', mime: 'image/svg+xml', bytes: SVG });
            const r = await t.get(`/tasks/${id}/files/${idOf(file)}`, { as: kim });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.headers.get('content-type'), 'image/svg+xml');
            assert.strictEqual(r.headers.get('content-security-policy'), "sandbox; default-src 'none'");
            assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
            assert.match(r.headers.get('content-disposition') || '', /^attachment/);
            assert.match(r.headers.get('content-disposition') || '', /revenue\.svg/);
            assert.match(r.headers.get('cache-control') || '', /private/);
            assert.strictEqual(r.text, SVG);
        });

        await check('a raster image is shown in place, an SVG or a page is a download', async () => {
            const id = await makeTask(t, owner);
            const store = createArtifactStore({ store: t.ctx.s, config: t.config, taskId: id, requester: owner });
            const png = await store.save({ kind: 'file', name: 'shot.png', mime: 'image/png', bytes: PNG });
            const r = await t.get(`/tasks/${id}/files/${idOf(png)}`, { as: kim });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.headers.get('content-type'), 'image/png');
            assert.match(r.headers.get('content-disposition') || '', /^inline/);
            const page = await store.save({ kind: 'file', name: 'page.html', mime: 'text/html', bytes: '<!doctype html><title>x</title>' });
            const h = await t.get(`/tasks/${id}/files/${idOf(page)}`, { as: kim });
            assert.strictEqual(h.status, 200, h.text);
            assert.strictEqual(h.headers.get('content-type'), 'text/html');
            assert.match(h.headers.get('content-disposition') || '', /^attachment/);
            assert.strictEqual(h.headers.get('content-security-policy'), "sandbox; default-src 'none'");
        });

        await check('the API route the manifest names serves the same bytes, to the owner only', async () => {
            const id = await makeTask(t, owner);
            const store = createArtifactStore({ store: t.ctx.s, config: t.config, taskId: id, requester: owner });
            const file = await store.save({ kind: 'chart', name: 'revenue.svg', mime: 'image/svg+xml', bytes: SVG });
            const r = await t.get(`/api/v1/tasks/${id}/artifacts/${idOf(file)}`, { as: kim });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.headers.get('content-type'), 'image/svg+xml');
            assert.strictEqual(r.headers.get('content-security-policy'), "sandbox; default-src 'none'");
            assert.strictEqual(r.text, SVG);
            assert.strictEqual((await t.get(`/api/v1/tasks/${id}/artifacts/${idOf(file)}`, { as: lee })).status, 404);
        });

        await check('another person gets the same 404 as a task that does not exist', async () => {
            const id = await makeTask(t, owner);
            const store = createArtifactStore({ store: t.ctx.s, config: t.config, taskId: id, requester: owner });
            const file = await store.save({ kind: 'chart', name: 'revenue.svg', mime: 'image/svg+xml', bytes: SVG });
            assert.strictEqual((await t.get(`/tasks/${id}/files/${idOf(file)}`, { as: lee })).status, 404);
            assert.strictEqual((await t.get(`/tasks/${id}/files/${idOf(file)}`)).status, 404, 'not signed in');
            assert.strictEqual((await t.get(`/tasks/${id}/files/${idOf(file)}`, { as: lee })).text, 'No such file');
        });

        await check('an artifact belongs to its own task', async () => {
            const one = await makeTask(t, owner);
            const two = await makeTask(t, owner);
            const store = createArtifactStore({ store: t.ctx.s, config: t.config, taskId: one, requester: owner });
            const file = await store.save({ kind: 'file', name: 'notes.md', mime: 'text/markdown', bytes: '# notes' });
            assert.strictEqual((await t.get(`/tasks/${one}/files/${idOf(file)}`, { as: kim })).status, 200);
            assert.strictEqual((await t.get(`/tasks/${two}/files/${idOf(file)}`, { as: kim })).status, 404);
            assert.strictEqual((await t.get(`/tasks/${one}/files/art_nope`, { as: kim })).status, 404);
            assert.strictEqual((await t.get(`/tasks/${one}/files/..%2F..%2Fetc%2Fpasswd`, { as: kim })).status, 404);
            assert.strictEqual((await t.get(`/tasks/tsk_nope/files/${idOf(file)}`, { as: kim })).status, 404);
        });

        await check('a task the person does not own is not there at all', async () => {
            const id = await makeTask(t, `user:${lee.subject}`);
            const store = createArtifactStore({ store: t.ctx.s, config: t.config, taskId: id, requester: `user:${lee.subject}` });
            const file = await store.save({ kind: 'file', name: 'notes.md', mime: 'text/markdown', bytes: '# notes' });
            assert.strictEqual((await t.get(`/tasks/${id}/files/${idOf(file)}`, { as: kim })).status, 404);
        });
    } finally {
        await t.close();
    }

    done();
})();
