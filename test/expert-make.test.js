'use strict';
/**
 * Make your own Expert (plan §AD.28 item 9): /experts/new makes a private draft (from a few fields, or with a pasted
 * SOUL.md as its soul), /experts/:id/edit saves and publishes it, /experts/mine lists yours, and Remix copies a published
 * Expert whose author allows it. Every write is same-origin; another person's draft is not yours to edit.
 *   node test/expert-make.test.js
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { startersFrom } = require('../server/http/expert-make-pages');

const SAME = { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1' };
const SOUL_MD = `# SOUL.md
## Who I am
A patient plant doctor who has kept a greenhouse for thirty years.
## How I talk
Warm and brief. I ask one question at a time.
## What I believe
- Most plants die of too much water.
## What I never do
- Recommend a pesticide without saying what it harms.
`;

(async () => {
    await check('starters: "Label: what to say" lines, at most six', async () => {
        assert.deepStrictEqual(startersFrom('Yellow leaves: Why are my leaves yellow?\nWater less?\n\n'), [
            { label: 'Yellow leaves', text: 'Why are my leaves yellow?' }, { label: 'Water less?', text: 'Water less?' }]);
        assert.strictEqual(startersFrom('a\nb\nc\nd\ne\nf\ng').length, 6);
    });

    const t = await boot();
    const ada = t.network.addUser('ada');
    const bo = t.network.addUser('bo');
    try {
        let id;
        await check('make one: a private draft, with a pasted SOUL.md as its soul, landing on its edit page', async () => {
            const form = await t.get('/experts/new', { as: ada });
            assert.strictEqual(form.status, 200);
            assert.match(form.text, /paste a SOUL\.md/);
            const r = await t.get('/experts/new', { as: ada, method: 'POST', headers: SAME, form: { name: 'Plant doctor', summary: 'Says what is wrong with a plant from what you describe.', instructions: 'You help people keep their plants alive. Ask what they see, then say the likeliest cause and one thing to try.', soul_md: SOUL_MD } });
            assert.strictEqual(r.status, 303, r.text.slice(0, 400));
            const m = /^\/experts\/(bp_[A-Za-z0-9_-]+)\/edit\?made=1$/.exec(r.headers.get('location'));
            assert.ok(m, r.headers.get('location'));
            id = m[1];
            const row = await t.ctx.s.db.maybe('SELECT visibility, latest, draft FROM agent_blueprints WHERE id = $1', [id]);
            assert.strictEqual(row.visibility, 'private');
            assert.strictEqual(row.latest, null, 'not published');
            const draft = typeof row.draft === 'string' ? JSON.parse(row.draft) : row.draft;
            assert.strictEqual(draft.name, 'Plant doctor');
            assert.ok(draft.soul && JSON.stringify(draft.soul).includes('greenhouse'), 'the SOUL.md became its soul');
            const edit = await t.get(r.headers.get('location'), { as: ada });
            assert.strictEqual(edit.status, 200);
            assert.match(edit.text, /Made\. It is private until you publish it\./);
            assert.match(edit.text, /type="radio" name="visibility" value="private" checked/);
            assert.ok(!/<select/.test(edit.text), 'no native select');
        });

        await check('your Experts lists it, a draft; the gallery links to making one', async () => {
            const r = await t.get('/experts/mine', { as: ada });
            assert.strictEqual(r.status, 200);
            assert.match(r.text, new RegExp(`href="/experts/${id}/edit"><b>Plant doctor</b>`));
            assert.match(r.text, /a draft, not published/);
            assert.match((await t.get('/experts')).text, /href="\/experts\/new">Make your own Expert</);
        });

        await check('save and publish to everyone: its page answers anyone, with its starters', async () => {
            const r = await t.get(`/experts/${id}/edit`, { as: ada, method: 'POST', headers: SAME, form: { action: 'publish', name: 'Plant doctor', summary: 'Says what is wrong with a plant from what you describe.', instructions: 'You help people keep their plants alive.', soul_md: SOUL_MD, starters: 'Yellow leaves: Why are my leaves turning yellow?', visibility: 'public' } });
            assert.strictEqual(r.status, 303, r.text.slice(0, 400));
            assert.strictEqual(r.headers.get('location'), `/experts/${id}`);
            const page = await t.get(`/experts/${id}`);
            assert.strictEqual(page.status, 200);
            assert.match(page.text, /Plant doctor/);
            assert.match(page.text, /Yellow leaves/);
            const mine = await t.get('/experts/mine', { as: ada });
            assert.match(mine.text, /published, version 1/);
        });

        await check('another person cannot edit it; Remix needs a licence; a cross-site post is refused', async () => {
            assert.strictEqual((await t.get(`/experts/${id}/edit`, { as: bo })).status, 404);
            const sneaky = await t.get(`/experts/${id}/edit`, { as: bo, method: 'POST', headers: SAME, form: { name: 'Mine now', summary: 'x', instructions: 'x', visibility: 'public' } });
            assert.strictEqual(sneaky.status, 404);
            const noLicence = await t.get(`/experts/${id}/remix`, { as: bo, method: 'POST', headers: SAME, form: {} });
            assert.strictEqual(noLicence.status, 403);
            assert.match(noLicence.text, /not allowed remixes/);
            const cross = await t.get('/experts/new', { as: ada, method: 'POST', headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }, form: { name: 'x', summary: 'x', instructions: 'x' } });
            assert.strictEqual(cross.status, 403);
        });

        await check('Remix: a private copy of an Expert that allows it, on its edit page', async () => {
            const stock = await t.ctx.s.db.many("SELECT id FROM agent_blueprints WHERE owner = 'service:actor' ORDER BY id");
            let remixed = null;
            for (const row of stock) {
                const r = await t.get(`/experts/${row.id}/remix`, { as: bo, method: 'POST', headers: SAME, form: {} });
                if (r.status === 303) { remixed = r; break; }
            }
            if (!remixed) return console.log('    (no stock Expert names a licence: Remix shows only where one does)');
            assert.match(remixed.headers.get('location'), /^\/experts\/bp_[A-Za-z0-9_-]+\/edit\?remixed=1$/);
            const edit = await t.get(remixed.headers.get('location'), { as: bo });
            assert.match(edit.text, /Your copy/);
        });

        await check('signed out: the pages sign you in first', async () => {
            assert.strictEqual((await t.get('/experts/mine')).status, 303);
            assert.strictEqual((await t.get('/experts/new')).status, 303);
        });
    } finally {
        await t.close?.();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
