'use strict';
/**
 * An agent's soul (actor-characters.md §3; agents.soul@1, Contracts 0.424.0; SDK 0.165.0; migration 0072): who an agent
 * is in plain words. A create and a patch take it; a good one is validated by the SDK and shown with its SOUL.md; the
 * soul is the first prompt block and the first prompt layer; a SOUL.md imports; a change is only a suggestion until the
 * person accepts it; and the menu's faces route says each agent's face, hue, glyph, state and asks with no secrets,
 * instructions or memory.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const personal = require('../server/agents/personal');
const store = require('../server/tasks/store');
const approvals = require('../server/agents/approvals');

const SAME = { 'sec-fetch-site': 'same-origin' };
const GOOD = {
    who: 'A dry, fast producer who keeps your stream on time',
    dials: { warmth: -1, play: 1, length: -2, edge: 1 },
    quirks: ['Counts down the last minute before you go live'],
    believes: ['Chat is the show too'],
    pushback: 'Says so once, plainly, with the reason.',
    never: ['Talks over a guest'],
    made_from: 'words',
};

(async () => {
    const t = await boot();
    try {
        const alice = t.network.addUser('soul-alice');
        const bob = t.network.addUser('soul-bob');
        const owner = `user:${alice.subject}`;
        const post = (path, json, as = alice, method = 'POST') => t.get(path, { as, method, json, headers: SAME });
        let juniper;

        await check('a create takes a good soul; a bad dial and a permission are 422 with the part named', async () => {
            const badDial = await post('/api/v1/agents', { name: 'Bad dial', soul: { who: 'Someone', dials: { edge: 3 } } });
            assert.strictEqual(badDial.status, 422, badDial.text);
            assert.match(badDial.json().detail, /dials\.edge: a whole number from -2 to 2/);
            const permission = await post('/api/v1/agents', { name: 'Bad hands', soul: { who: 'Helpful', hands: [{ tool: 'ov:wallet.pay', mode: 'allow' }] } });
            assert.strictEqual(permission.status, 422, permission.text);
            assert.match(permission.json().detail, /hands: a soul says who an agent is, never what it may do/);
            assert.strictEqual((await post('/api/v1/agents', { name: 'Bad shape', soul: 'a line' })).status, 422);

            const made = await post('/api/v1/agents', { name: 'Juniper', soul: GOOD });
            assert.strictEqual(made.status, 201, made.text);
            juniper = made.json();
            assert.deepStrictEqual(juniper.soul, GOOD);
            assert.match(juniper.soul_md, /^# Juniper: soul\n\n## Who I am\n\nA dry, fast producer/);
            assert.match(juniper.soul_md, /## I never\n\n- Talks over a guest/);
            const read = await t.get(`/api/v1/agents/${juniper.id}`, { as: alice });
            assert.deepStrictEqual(read.json().soul, GOOD, 'the soul is stored and read back');
            assert.strictEqual((await t.get(`/api/v1/agents/${juniper.id}`, { as: bob })).status, 404, 'another person reaches nothing');
            const noSoul = await post('/api/v1/agents', { name: 'Plain' });
            assert.strictEqual(noSoul.status, 201);
            assert.strictEqual(noSoul.json().soul, null, 'an agent made before a soul says null');
            assert.ok(!('soul_md' in noSoul.json()), 'no SOUL.md without a soul');
        });

        await check('the soul is the first prompt block and the first prompt layer', async () => {
            const agent = await personal.get(t.ctx.s, owner, juniper.id);
            const prompt = personal.prompt(agent, [], 'Plan the next stream');
            assert.ok(prompt.startsWith('You are Juniper. A dry, fast producer who keeps your stream on time'), prompt.slice(0, 120));
            assert.ok(prompt.indexOf('You are Juniper.') < prompt.indexOf('Personal agent instructions'), 'the soul comes before the person\'s instructions');
            assert.ok(prompt.indexOf('How you talk: a little dry, a little playful, very brief, a little blunt.') > 0);
            const layers = personal.promptLayers(agent, [], 'Plan the next stream');
            assert.strictEqual(layers[0].name, 'soul');
            assert.deepStrictEqual([layers[0].layer, layers[0].source, layers[0].version], ['person', 'actor_agents.soul', agent.updated_at]);
            assert.match(layers[0].text, /^You are Juniper\./);
            assert.strictEqual(layers[1].name, 'person-instructions');
            // The remember tool reads the person's own words only: never the soul, never the run input.
            assert.ok(personal.personText(prompt).startsWith('Personal agent instructions'));
            assert.ok(!personal.personText(prompt).includes('A dry, fast producer'));
            assert.ok(!personal.personText(prompt).includes('Plan the next stream'));
        });

        await check('a SOUL.md imports into the soul; a secret in one is refused, and so is more than 20 KB', async () => {
            const md = '# Juniper: soul\n\n## Who I am\n\nA patient study partner who checks every claim.\n\n## What I believe\n\n- Slow is smooth.\n\n## I never\n\n- Shares my notes.\n';
            const r = await post(`/api/v1/agents/${juniper.id}/soul/import`, { soul_md: md });
            assert.strictEqual(r.status, 200, r.text);
            assert.match(r.json().soul.who, /patient study partner/);
            assert.strictEqual(r.json().soul.made_from, 'soul-md');
            assert.deepStrictEqual(r.json().soul.never, ['Shares my notes.']);
            assert.match(r.json().soul_md, /## I never/);
            const leak = await post(`/api/v1/agents/${juniper.id}/soul/import`, { soul_md: '# Soul\n\n## Notes\n\nmy key is sk-ant-abcdefghijklmnopqrstuvwxyz\n' });
            assert.strictEqual(leak.status, 422, leak.text);
            assert.match(leak.json().detail, /secret/);
            const big = await post(`/api/v1/agents/${juniper.id}/soul/import`, { soul_md: 'x'.repeat(20 * 1024 + 1) });
            assert.strictEqual(big.status, 422);
            assert.match(big.json().detail, /20 KB/);
            assert.strictEqual((await post(`/api/v1/agents/${juniper.id}/soul/import`, { soul_md: 'x' }, bob)).status, 404);
        });

        await check('a soul change is only a suggestion: accept applies its words, dismiss leaves the soul alone', async () => {
            const before = (await t.get(`/api/v1/agents/${juniper.id}`, { as: alice })).json().soul;
            const proposed = await post(`/api/v1/agents/${juniper.id}/soul/suggest`, { patch: { dials: { warmth: 2 }, quirks: ['Signs off with a star'] } });
            assert.strictEqual(proposed.status, 200, proposed.text);
            assert.match(proposed.json().words, /talks very warm/);
            assert.match(proposed.json().words, /quirks: Signs off with a star/);
            assert.strictEqual(proposed.json().suggestion.kind, 'soul');
            assert.ok(proposed.json().suggestion.draft);
            assert.deepStrictEqual((await t.get(`/api/v1/agents/${juniper.id}`, { as: alice })).json().soul, before, 'nothing changes before the yes');

            const applied = await post(`/api/v1/me/agents/${juniper.id}/suggestions/${proposed.json().suggestion.id}/apply`, {});
            assert.strictEqual(applied.status, 200, applied.text);
            const after = applied.json().agent.soul;
            assert.strictEqual(after.dials.warmth, 2);
            assert.deepStrictEqual(after.quirks, ['Signs off with a star']);

            const second = await post(`/api/v1/agents/${juniper.id}/soul/suggest`, { patch: { who: 'A different agent entirely' } });
            assert.strictEqual(second.status, 200, second.text);
            const dismissed = await post(`/api/v1/me/agents/${juniper.id}/suggestions/${second.json().suggestion.id}/dismiss`, {});
            assert.strictEqual(dismissed.status, 200, dismissed.text);
            assert.strictEqual((await t.get(`/api/v1/agents/${juniper.id}`, { as: alice })).json().soul.who, after.who, 'dismiss changes nothing');

            const bad = await post(`/api/v1/agents/${juniper.id}/soul/suggest`, { patch: { dials: { warmth: 5 } } });
            assert.strictEqual(bad.status, 422, bad.text);
            assert.match(bad.json().detail, /dials\.warmth/);
            assert.strictEqual((await post(`/api/v1/agents/${juniper.id}/soul/suggest`, { patch: { who: 'Mine' } }, bob)).status, 404);
        });

        await check('the faces route has the menu shape: work, asks, paused and resting, newest activity first', async () => {
            const worker = (await personal.create(t.ctx.s, t.config, owner, { name: 'Worker', instructions: 'Work carefully.' })).row;
            const sleepy = (await personal.create(t.ctx.s, t.config, owner, { name: 'Sleepy', instructions: 'Rest.', status: 'paused' })).row;
            const now = Date.parse(t.ctx.s.iso());
            const task = await store.insertTask(t.ctx.s, {
                id: t.ctx.s.newId('tsk'), requester: owner, task: 'Read the job posts', mode: 'balanced', agent: null,
                budget_task: 0.01, budget_day: 1, created_at: new Date(now + 60_000).toISOString(), via: `agent:${worker.id}`,
            });
            await t.ctx.s.db.query("UPDATE tasks SET state = 'running' WHERE id = $1", [task.id]);
            await approvals.request(t.ctx.s, { owner, agentId: juniper.id, kind: 'publish', summary: 'Publish your post', payload: { why: 'it is public' } });

            const r = await t.get('/api/v1/me/agents/faces', { as: alice });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.headers.get('cache-control'), 'private, max-age=15');
            const agents = r.json().agents;
            assert.ok(agents.length <= 12);
            const by = Object.fromEntries(agents.map((a) => [a.name, a]));
            for (const a of agents) assert.deepStrictEqual(Object.keys(a).sort(), ['asks', 'avatar_url', 'glyph', 'hue', 'id', 'name', 'state', 'step'].sort());
            assert.strictEqual(by.Worker.state, 'working');
            assert.strictEqual(by.Worker.step, 'Read the job posts');
            assert.strictEqual(by.Worker.asks, 0);
            assert.strictEqual(by.Juniper.state, 'asks');
            assert.strictEqual(by.Juniper.asks, 1);
            assert.strictEqual(by.Sleepy.state, 'paused');
            assert.strictEqual(by.Vibe.state, 'resting');
            assert.strictEqual(by.Vibe.glyph, 'spark');
            assert.strictEqual(by.Vibe.hue, 258);
            assert.strictEqual(by.Vibe.avatar_url, null);
            assert.strictEqual(agents[0].name, 'Worker', 'newest activity first');
            const text = JSON.stringify(agents);
            assert.ok(!text.includes('Work carefully.'), 'no instructions');
            assert.ok(!text.includes('A dry, fast producer'), 'no soul');
            assert.ok(!text.includes('Publish your post'), 'no asks in words');
        });

        await check('the menu may read the faces from openvibe.network with the person\'s bearer, and only then', async () => {
            const origin = { origin: 'https://openvibe.network' };
            const pre = await t.get('/api/v1/me/agents/faces', { method: 'OPTIONS', headers: { ...origin, 'access-control-request-method': 'GET' } });
            assert.strictEqual(pre.status, 204);
            assert.strictEqual(pre.headers.get('access-control-allow-origin'), 'https://openvibe.network');
            const r = await t.get('/api/v1/me/agents/faces', { bearer: t.network.userToken(alice), headers: origin });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.headers.get('access-control-allow-origin'), 'https://openvibe.network');
            assert.strictEqual((await t.get('/api/v1/me/agents/faces', { headers: origin })).status, 401, 'cookies are not read from another site');
        });

        await check('the expand migration adds soul jsonb and lets a proposal be kind soul', async () => {
            const col = await t.ctx.s.db.maybe("SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'actor_agents' AND column_name = 'soul'");
            assert.deepStrictEqual(col, { data_type: 'jsonb' });
            const def = await t.ctx.s.db.value("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'actor_agent_proposals_kind_check'");
            assert.match(def, /'soul'/);
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
