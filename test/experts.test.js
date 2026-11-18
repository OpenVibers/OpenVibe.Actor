'use strict';
/**
 * OpenVibe's first ten Experts (plan §D item 10) and the signed-out gallery (openvibe.expert, §D item 6).
 *
 * - The documents in experts/ are agents.blueprint@1 and pass the SDK's own rules. Each has a soul, starters and the
 *   floor in words. Each compiles to a prompt. The money ones never pay, and the live ones never post on their own.
 * - Boot publishes them as public versions of service:actor. A second boot changes nothing. A changed file becomes
 *   version 2, and the first version is kept as it was. An id somebody else owns is never taken over.
 * - GET /api/v1/gallery answers anyone, signed in or not, OpenVibe's own first. GET /api/v1/gallery/:id answers one
 *   Expert with its install asks. A private blueprint is 404 there.
 *   node test/experts.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const contracts = require('openvibe-contracts');
const bp = require('openvibe-sdk/agents/blueprint');
const stock = require('../server/agents/stock');
const { boot, check, done } = require('./helpers/boot');

const DIR = path.join(__dirname, '..', 'experts');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
const docs = files.map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
const SAME = { 'sec-fetch-site': 'same-origin' };

(async () => {
    await check('the ten documents: valid, with a soul and starters, compiled, the money ones never pay', async () => {
        assert.strictEqual(docs.length, 10, files.join(' '));
        assert.strictEqual(new Set(docs.map((d) => d.id)).size, 10, 'ids are unique');
        for (const [i, d] of docs.entries()) {
            const at = files[i];
            assert.deepStrictEqual(contracts.validate('agents.blueprint@1', d).errors, [], at);
            assert.deepStrictEqual(bp.validate(d).errors, [], at);
            assert.strictEqual(`${d.id.slice(3).replace(/_/g, '-')}.json`, at, 'the file is named after the id');
            assert.deepStrictEqual([d.author, d.visibility, d.licence, d.version, d.state], [{ type: 'service', id: 'actor' }, 'public', 'MIT', 1, 'published'], at);
            assert.ok(d.soul && d.soul.who && d.soul.never && d.soul.never.length, `${at}: a soul with what it never does`);
            assert.ok(d.starters && d.starters.length >= 2, `${at}: starters`);
            assert.ok(d.knows.examples && d.knows.examples.length, `${at}: an example for Try it`);
            const inputs = Object.fromEntries((d.inputs || []).map((x) => [x.id, 'ada']));
            const out = bp.compile(d, { inputs, install: { agent: 'agt_test', inputs, places: {} } });
            assert.ok(out.loop.system.includes(d.soul.who) || out.loop.system.length > 200, `${at}: compiles`);
        }
        const by = Object.fromEntries(docs.map((d) => [d.id, d]));
        for (const id of ['bp_purchase_researcher', 'bp_subscription_auditor', 'bp_budget_coach', 'bp_job_researcher', 'bp_compute_buyer']) {
            assert.ok(by[id].soul.never.some((n) => /\b(Buys|Cancels|Moves money|Applies|Signs up)\b/.test(n)), `${id} says what it never does with money or accounts`);
            assert.strictEqual(by[id].rules.level, 'ask');
        }
        for (const id of ['bp_stream_producer', 'bp_stream_moderator', 'bp_clip_finder']) {
            const post = by[id].hands.tools.find((t) => t.tool === 'ov:live.chat.post');
            assert.strictEqual(post && post.mode, 'ask', `${id} posts in chat only with a yes`);
        }
    });

    const t = await boot();
    try {
        const s = t.ctx.s;
        await check('boot published them: public versions of service:actor; a second seed changes nothing', async () => {
            const rows = await s.db.many("SELECT id, owner, visibility, latest FROM agent_blueprints WHERE owner = 'service:actor' ORDER BY id");
            assert.strictEqual(rows.length, 10);
            assert.ok(rows.every((r) => r.visibility === 'public' && Number(r.latest) === 1));
            const again = await stock.seed(s, { log: { warn() {}, info() {} } });
            assert.deepStrictEqual([again.published, again.same, again.skipped], [[], 10, []]);
        });

        await check('a changed file is the next version; the first stays as it was; an id someone else owns is skipped', async () => {
            const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'experts-'));
            for (const f of files) fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
            const p = path.join(tmp, 'compute-buyer.json');
            const d = JSON.parse(fs.readFileSync(p, 'utf8'));
            d.summary = 'Finds compute at the best price right now.';
            fs.writeFileSync(p, JSON.stringify(d));
            await s.db.query("INSERT INTO agent_blueprints (id, owner, visibility, latest, draft, forked_from, created_at, updated_at) VALUES ('bp_job_researcher_x', 'user:usr_someone', 'private', NULL, NULL, NULL, now(), now())");
            fs.writeFileSync(path.join(tmp, 'job-researcher-x.json'), JSON.stringify({ ...docs.find((x) => x.id === 'bp_job_researcher'), id: 'bp_job_researcher_x' }));
            const out = await stock.seed(s, { dir: tmp, log: { warn() {}, info() {} } });
            assert.deepStrictEqual(out.published, ['bp_compute_buyer@2']);
            assert.deepStrictEqual(out.skipped, ['bp_job_researcher_x'], 'never takes over an id');
            const v1 = await s.db.one("SELECT doc FROM agent_blueprint_versions WHERE blueprint_id = 'bp_compute_buyer' AND version = 1");
            const doc1 = typeof v1.doc === 'string' ? JSON.parse(v1.doc) : v1.doc;
            assert.notStrictEqual(doc1.summary, d.summary, 'version 1 never changes');
            const owner = await s.db.one("SELECT owner FROM agent_blueprints WHERE id = 'bp_job_researcher_x'");
            assert.strictEqual(owner.owner, 'user:usr_someone');
            fs.rmSync(tmp, { recursive: true, force: true });
        });

        await check('GET /api/v1/gallery: anyone, signed out too, OpenVibe\'s own first, cached a minute', async () => {
            const r = await t.get('/api/v1/gallery');
            assert.strictEqual(r.status, 200, r.text);
            assert.match(String(r.headers['cache-control'] || r.headers.get && r.headers.get('cache-control')), /public, max-age=60/);
            const list = r.json().experts;
            assert.ok(list.length >= 10);
            assert.ok(list.slice(0, 10).every((e) => e.official === true), 'OpenVibe\'s own first');
            const cb = list.find((e) => e.id === 'bp_compute_buyer');
            assert.strictEqual(cb.name, 'Compute buyer');
            assert.ok(cb.who && cb.face && cb.face.glyph && cb.starters.length >= 2);
            assert.ok(!JSON.stringify(list).includes('"instructions"'), 'a card is a card: the document is one more read');
        });

        await check('GET /api/v1/gallery/:id: one Expert with its install asks; a private one is 404', async () => {
            const r = await t.get('/api/v1/gallery/bp_stream_producer');
            assert.strictEqual(r.status, 200, r.text);
            const body = r.json();
            assert.strictEqual(body.blueprint.id, 'bp_stream_producer');
            assert.ok(body.asks.some((a) => a.key === 'hands:ov:live.chat.post' && a.ask === true), JSON.stringify(body.asks).slice(0, 400));
            assert.deepStrictEqual(body.inputs, [{ id: 'channel', label: 'Your channel' }]);
            const ada = t.network.addUser('exp-ada');
            const mine = await t.get('/api/v1/blueprints', { as: ada, method: 'POST', headers: SAME, json: {
                name: 'Mine', summary: 'A private one.', knows: { instructions: 'Hello.' }, memory: { scope: 'none' } } });
            assert.strictEqual(mine.status, 201, mine.text);
            assert.strictEqual((await t.get(`/api/v1/gallery/${mine.json().id}`)).status, 404, 'a private draft is not in the gallery');
            assert.strictEqual((await t.get('/api/v1/gallery/bp_nope_nope')).status, 404);
        });
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    } finally {
        await t.close();
    }
    done();
})();
