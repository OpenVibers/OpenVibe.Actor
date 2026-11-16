'use strict';
// Faces: pictures for your Actor and your agents (server/faces; the owner, 11-16: "you never added the image generator,
// like avatar system … edit your actor … rename it"):
//   generate asks OpenVibe.AI's image route as the person (a square portrait, the style, their words, no text) and keeps
//   each picture here; an upload is checked by its first bytes (never its declared type) and its size;
//   GET /faces/:id serves it (a year's cache, nosniff); PUT /agents/:id/face sets an agent's face ref and `actor` names
//   your first agent, whose picture is the Actor's too; nobody uses another person's picture; signed out is refused.
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { promptOf, sniff } = require('../server/faces');

const SAME = { 'sec-fetch-site': 'same-origin' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

(async () => {
    await check('the prompt and the bytes check', async () => {
        const p = promptOf({ name: 'Ada\'s helper', description: 'a fox in a scarf', style: 'pixel' });
        assert.match(p, /"Ada's helper"/);
        assert.match(p, /a fox in a scarf/);
        assert.match(p, /16-bit pixel art/);
        assert.match(p, /no text, no letters, no logo, no watermark/);
        assert.match(promptOf({}), /a friendly AI assistant/);
        assert.strictEqual(sniff(PNG), 'image/png');
        assert.strictEqual(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null, 'an SVG is not a picture here');
    });

    const t = await boot();
    try {
        const asked = [];
        t.ctx.models.image = async (a) => { asked.push(a); return { images: Array.from({ length: a.n }, () => ({ b64: PNG.toString('base64') })), cost_usd: 0.004 * a.n }; };
        const ada = t.network.addUser('ada');
        const kim = t.network.addUser('kim');

        await check('generate: as the person, n pictures kept here and served', async () => {
            const r = await t.get('/api/v1/me/faces/generate', { as: ada, headers: SAME, json: { name: 'Ada', description: 'a fox in a scarf', style: 'pixel', n: 2 } });
            assert.strictEqual(r.status, 201, r.text);
            const out = r.json();
            assert.strictEqual(out.faces.length, 2);
            assert.ok(out.faces.every((f) => /^https:\/\/openvibe\.actor\/faces\/fac_/.test(f.url)), JSON.stringify(out.faces));
            assert.strictEqual(asked.length, 1);
            assert.strictEqual(asked[0].n, 2);
            assert.match(asked[0].prompt, /16-bit pixel art/);
            assert.ok(asked[0].subject && !String(asked[0].subject).startsWith('user:'), 'on behalf of the person');
            const img = await t.get(new URL(out.faces[0].url).pathname);
            assert.strictEqual(img.status, 200);
            assert.match(img.headers.get('cache-control'), /immutable/);
            assert.strictEqual(img.headers.get('x-content-type-options'), 'nosniff');
            // One shape for every face: 512 px square WebP (sharp is a dependency here).
            assert.strictEqual(img.headers.get('content-type'), 'image/webp');
            const meta = await require('sharp')(img.buffer).metadata();
            assert.deepStrictEqual([meta.format, meta.width, meta.height], ['webp', 512, 512]);
            assert.strictEqual((await t.get('/api/v1/me/faces/generate', { as: ada, headers: SAME, json: { style: 'neon' } })).status, 422, 'an unknown style is refused');
        });

        let upload;
        await check('upload: the first bytes decide, not the declared type', async () => {
            let r = await t.get('/api/v1/me/faces', { as: ada, headers: { ...SAME, 'content-type': 'image/png' }, body: PNG });
            assert.strictEqual(r.status, 201, r.text);
            upload = r.json();
            r = await t.get('/api/v1/me/faces', { as: ada, headers: { ...SAME, 'content-type': 'image/png' }, body: Buffer.from('<svg onload="alert(1)"></svg> padding padding') });
            assert.strictEqual(r.status, 422, 'not a picture');
            const list = (await t.get('/api/v1/me/faces', { as: ada })).json();
            assert.strictEqual(list.faces.length, 3);
            assert.ok(list.styles.some((s) => s.id === 'pixel'));
        });

        await check('your Actor and your agents wear them; nobody else\'s', async () => {
            const made = await t.get('/api/v1/agents', { as: ada, headers: SAME, json: { name: 'Ada', instructions: 'Help Ada with her week.' } });
            assert.strictEqual(made.status, 201, made.text);
            const second = await t.get('/api/v1/agents', { as: ada, headers: SAME, json: { name: 'Scout', instructions: 'Find deals.' } });
            assert.strictEqual(second.status, 201, second.text);
            const faceId = new URL(upload.url).pathname.split('/').pop();
            let r = await t.get('/api/v1/agents/actor/face', { method: 'PUT', as: ada, headers: SAME, json: { face: faceId } });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().face, `face:${faceId}`);
            r = await t.get(`/api/v1/agents/${second.json().id}/face`, { method: 'PUT', as: ada, headers: SAME, json: { face: faceId } });
            assert.strictEqual(r.status, 200, r.text);
            const got = (await t.get(`/api/v1/agents/${second.json().id}`, { as: ada })).json();
            // The agent's wire (actor.agent@1) carries the ref; its picture is <actor>/faces/<id>.
            assert.strictEqual(got.face, `face:${faceId}`);
            // Back to its preset.
            r = await t.get(`/api/v1/agents/${second.json().id}/face`, { method: 'PUT', as: ada, headers: SAME, json: { face: null } });
            assert.deepStrictEqual([r.status, r.json().face_url], [200, null]);
            // Kim cannot wear Ada's picture.
            await t.get('/api/v1/agents', { as: kim, headers: SAME, json: { name: 'Kim', instructions: 'Help Kim.' } });
            r = await t.get('/api/v1/agents/actor/face', { method: 'PUT', as: kim, headers: SAME, json: { face: faceId } });
            assert.strictEqual(r.status, 404, r.text);
            r = await t.get('/api/v1/agents/actor/face', { method: 'PUT', as: ada, headers: SAME, json: { face: 'not-a-face' } });
            assert.strictEqual(r.status, 422);
        });

        await check('signed out: refused', async () => {
            assert.strictEqual((await t.get('/api/v1/me/faces/generate', { headers: SAME, json: { name: 'x' } })).status, 401);
            assert.strictEqual((await t.get('/faces/fac_nope')).status, 404);
        });
    } finally {
        await t.close();
    }
    done('faces');
})().catch((e) => { console.error(e); process.exit(1); });
