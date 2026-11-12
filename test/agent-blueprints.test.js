'use strict';
/**
 * Make your own agent (agent-blueprints.md; agents.blueprint@1, agents.install@1): a person makes a blueprint as a
 * draft, publishes versions that never change, shares it by link or in public, and another person installs it as their
 * own agent after agreeing to every ask; a version that asks for more waits until they agree; a remix is a private copy
 * that credits its source. Nothing of a private blueprint is visible to anyone else (404).
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

const SAME = { 'sec-fetch-site': 'same-origin' };
const CLIP = {
    name: 'Clip finder', summary: 'Watches your stream\'s chat and clips the moments people react to.', visibility: 'public', licence: 'MIT',
    inputs: [{ id: 'channel', type: 'channel', label: 'Your channel', required: true }],
    face: { glyph: 'scissors', hue: 270, voice: null, tone: 'Short and cheerful.' },
    brain: { pick: 'size', size: 'small', caps: ['tools'] },
    knows: { instructions: 'You watch {{channel}}\'s stream. Clip what chat reacts to.' },
    hands: { tools: [{ tool: 'ov:live.chat.read', mode: 'allow' }, { tool: 'ov:media.clip.create', mode: 'allow' }, { tool: 'ov:live.chat.post', mode: 'ask' }] },
    places: { order: ['none'] },
    memory: { scope: 'person', keep_days: 30 },
    rules: { level: 'auto-edits', budget: { run_usd: 0.05, day_usd: 0.5 }, who: { may: 'owner' } },
    when: [{ kind: 'event', event: 'live.stream.started', where: { service: 'live', kind: 'channel', id: '{{channel}}' } }],
    makes: { answer: ['card:clip'] },
};

(async () => {
    const t = await boot();
    try {
        const ada = t.network.addUser('bp-ada');
        const sam = t.network.addUser('bp-sam');
        const call = (method, path, json, as = ada) => t.get(path, { as, method, json, headers: SAME });
        let id;

        await check('a draft: made, checked against agents.blueprint@1, and the store owns its id, version and author', async () => {
            const bad = await call('POST', '/api/v1/blueprints', { ...CLIP, knows: { instructions: 'Post in {{room}}' } });
            assert.strictEqual(bad.status, 422, bad.text);
            assert.ok(bad.json().errors.some((e) => e.at === '/knows/instructions'), bad.text);
            const secret = await call('POST', '/api/v1/blueprints', { ...CLIP, knows: { instructions: `Use sk-proj-${'a'.repeat(24)} for {{channel}}` } });
            assert.strictEqual(secret.status, 422, 'a blueprint carries no secret');
            const r = await call('POST', '/api/v1/blueprints', CLIP);
            assert.strictEqual(r.status, 201, r.text);
            const body = r.json();
            id = body.id;
            assert.match(id, /^bp_/);
            assert.deepStrictEqual([body.latest, body.has_draft, body.blueprint.version, body.blueprint.state], [null, true, 1, 'draft']);
            assert.deepStrictEqual(body.blueprint.author, { type: 'user', id: ada.subject.replace(/^user:/, '') || body.blueprint.author.id });
            assert.deepStrictEqual(contracts.validate('agents.blueprint@1', body.blueprint).errors, []);
        });

        await check('nobody else sees a draft, and nobody can install one', async () => {
            assert.strictEqual((await call('GET', `/api/v1/blueprints/${id}`, undefined, sam)).status, 404);
            assert.strictEqual((await call('POST', `/api/v1/blueprints/${id}/install`, { inputs: { channel: 'x' }, agreed: [] }, sam)).status, 404);
            assert.strictEqual((await call('PUT', `/api/v1/blueprints/${id}/draft`, CLIP, sam)).status, 404, 'only its owner edits it');
        });

        await check('publishing freezes version 1; the gallery lists it; its install screen is in words', async () => {
            const p = await call('POST', `/api/v1/blueprints/${id}/publish`);
            assert.strictEqual(p.status, 200, p.text);
            assert.deepStrictEqual([p.json().latest, p.json().blueprint.state, p.json().has_draft], [1, 'published', false]);
            assert.deepStrictEqual(contracts.validate('agents.blueprint@1', p.json().blueprint).errors, []);
            assert.strictEqual((await call('POST', `/api/v1/blueprints/${id}/publish`)).status, 409, 'nothing new to publish');
            const gallery = (await call('GET', '/api/v1/blueprints?scope=public', undefined, sam)).json();
            assert.ok(gallery.blueprints.some((b) => b.id === id), 'public: listed for anyone signed in');
            const asks = (await call('GET', `/api/v1/blueprints/${id}/asks`, undefined, sam)).json();
            assert.strictEqual(asks.blueprint, `${id}@1`);
            assert.ok(asks.asks.some((a) => a.key === 'hands:ov:live.chat.post' && a.ask === true));
            assert.ok(asks.floor.includes('money'));
        });

        let agent;
        await check('installing: every ask agreed and the inputs filled make the person\'s own agent (agents.install@1)', async () => {
            const asks = (await call('GET', `/api/v1/blueprints/${id}/asks`, undefined, sam)).json().asks.map((a) => a.key);
            const partly = await call('POST', `/api/v1/blueprints/${id}/install`, { inputs: { channel: 'samlive' }, agreed: asks.slice(1) }, sam);
            assert.strictEqual(partly.status, 422, 'every ask is agreed first');
            assert.strictEqual(partly.json().code, 'actor.blueprint.not_agreed');
            const noInput = await call('POST', `/api/v1/blueprints/${id}/install`, { agreed: asks }, sam);
            assert.strictEqual(noInput.status, 422, 'its inputs are filled');
            const r = await call('POST', `/api/v1/blueprints/${id}/install`, { inputs: { channel: 'samlive' }, agreed: asks, updates: 'same-or-less' }, sam);
            assert.strictEqual(r.status, 201, r.text);
            agent = r.json().agent;
            const install = r.json().install;
            assert.deepStrictEqual(contracts.validate('agents.install@1', install).errors, []);
            assert.deepStrictEqual([install.blueprint, install.updates, install.pending], [`${id}@1`, 'same-or-less', null]);
            assert.deepStrictEqual([agent.name, agent.level, agent.model.model], ['Clip finder', 'auto-edits', 'fast']);
            const row = await t.ctx.s.db.maybe('SELECT instructions, owner FROM actor_agents WHERE id = $1', [agent.id]);
            assert.match(row.instructions, /^You watch samlive's stream/, 'the inputs are filled in');
            assert.match(row.instructions, /Always ask the person first before spending money/, 'the floor, said in words');
            assert.strictEqual(row.owner, sam.subject.startsWith('user:') ? sam.subject : `user:${sam.subject}`);
            assert.strictEqual((await call('GET', `/api/v1/blueprints/${id}`)).json().installs, 1, 'the author sees it counted');
        });

        await check('a version that asks for no more moves an install set to take it; one that asks for more waits', async () => {
            const less = { ...CLIP, rules: { ...CLIP.rules, budget: { run_usd: 0.04, day_usd: 0.5 } } };
            assert.strictEqual((await call('PUT', `/api/v1/blueprints/${id}/draft`, less)).status, 200);
            assert.strictEqual((await call('POST', `/api/v1/blueprints/${id}/publish`)).json().latest, 2);
            let inst = (await call('GET', `/api/v1/agents/${agent.id}/install`, undefined, sam)).json();
            assert.deepStrictEqual([inst.blueprint, inst.pending], [`${id}@2`, null], 'less is taken without asking');

            const more = { ...less, hands: { tools: [...CLIP.hands.tools, { tool: 'ov:community.post.create', mode: 'ask' }] } };
            assert.strictEqual((await call('PUT', `/api/v1/blueprints/${id}/draft`, more)).status, 200);
            assert.strictEqual((await call('POST', `/api/v1/blueprints/${id}/publish`)).json().latest, 3);
            inst = (await call('GET', `/api/v1/agents/${agent.id}/install`, undefined, sam)).json();
            assert.deepStrictEqual([inst.blueprint, inst.pending], [`${id}@2`, `${id}@3`], 'more waits for a yes');
            const no = await call('POST', `/api/v1/agents/${agent.id}/install/update`, {}, sam);
            assert.strictEqual(no.status, 422, 'not without agreeing to what is new');
            assert.match(no.json().detail, /community: post create/);
            const yes = await call('POST', `/api/v1/agents/${agent.id}/install/update`, { agreed: ['hands:ov:community.post.create'] }, sam);
            assert.strictEqual(yes.status, 200, yes.text);
            assert.deepStrictEqual([yes.json().blueprint, yes.json().pending], [`${id}@3`, null]);
            assert.ok(yes.json().agreed.includes('hands:ov:community.post.create'));
            assert.strictEqual((await call('GET', `/api/v1/blueprints/${id}?version=1`, undefined, sam)).json().blueprint.version, 1, 'old versions stay readable');
        });

        await check('a remix is a private copy that credits its source; a private blueprint stays unseen', async () => {
            const r = await call('POST', `/api/v1/blueprints/${id}/remix?version=2`, {}, sam);
            assert.strictEqual(r.status, 201, r.text);
            const copy = r.json();
            assert.deepStrictEqual([copy.visibility, copy.forked_from, copy.blueprint.forked_from, copy.blueprint.author.type], ['private', `${id}@2`, `${id}@2`, 'user']);
            assert.strictEqual((await call('GET', `/api/v1/blueprints/${copy.id}`)).status, 404, 'Sam\'s private copy is not Ada\'s to see');
            assert.strictEqual((await call('GET', `/api/v1/blueprints/${id}`)).json().remixes, 1);
            const mine = (await call('GET', '/api/v1/blueprints', undefined, sam)).json().blueprints.map((b) => b.id);
            assert.ok(mine.includes(copy.id) && !mine.includes(id), 'mine is mine');
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
