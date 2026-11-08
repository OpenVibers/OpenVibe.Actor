'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const personal = require('../server/agents/personal');
const contracts = require('openvibe-contracts');
const skills = require('../server/skills');
const { createAgentPages } = require('../server/http/agent-pages');
const { createSkillPages } = require('../server/http/skills-pages');
const skillDraftCard = require('../server/http/skill-draft-card');

const SAME = { 'sec-fetch-site': 'same-origin' };
const draft = { name: 'Research a change', description: 'Use for a checked comparison across sources.', instructions: 'List the question. Read three independent sources. Compare their dates and claims. Summarize what changed and cite each source.' };
const steps = (n) => Array.from({ length: n }, () => ({ step_kind: 'work', ok: true }));

(async () => {
    assert.strictEqual(typeof createAgentPages, 'function');
    assert.strictEqual(typeof createSkillPages, 'function');
    assert.strictEqual(typeof skillDraftCard.card, 'function');
    let passed = true;
    const fakeRun = async ({ task }) => ({ text: `Answer.\nSKILL_DRAFT: ${JSON.stringify(draft)}`, sources: [], model: 'fake', brain: { steps: steps(task.includes('one step') ? 1 : 3) } });
    const t = await boot({ adapters: {
        checkers: { local: async () => ({ text: JSON.stringify({ ok: passed, reason: 'checked' }), cost_usd: 0 }) },
        run: { 'open-model': fakeRun, codes: fakeRun, 'openvibe-runtime': fakeRun, 'openai-agent': fakeRun },
    } });
    try {
        const alice = t.network.addUser('skill-author');
        const bob = t.network.addUser('skill-other');
        const owner = `user:${alice.subject}`;
        const agent = (await personal.create(t.ctx.s, t.config, owner, { name: 'Helper', instructions: 'Answer plainly.', mode: 'private', budget_per_run_usd: 0.02, daily_runs_max: 10, schedule: 'off', status: 'active' })).row;
        const another = (await personal.create(t.ctx.s, t.config, owner, { name: 'Second helper', instructions: 'Answer plainly.', mode: 'private', budget_per_run_usd: 0.02, daily_runs_max: 3, schedule: 'off', status: 'active' })).row;
        const bobAgent = (await personal.create(t.ctx.s, t.config, `user:${bob.subject}`, { name: 'Other helper', instructions: 'Answer plainly.', mode: 'private', budget_per_run_usd: 0.02, daily_runs_max: 3, schedule: 'off', status: 'active' })).row;
        const run = async (input) => {
            const out = await personal.run(t.ctx, agent, input);
            assert.strictEqual(out.status, 201);
            return t.waitFor(out.task.id);
        };

        await check('only a passed multi-step run offers one skill; the draft is removed from the answer', async () => {
            const one = await run('one step');
            assert.strictEqual(one.state, 'succeeded', one.error_detail || one.error_code);
            assert.strictEqual((await personal.proposals(t.ctx.s, owner, agent.id)).length, 0);
            assert.strictEqual((typeof one.result === 'string' ? JSON.parse(one.result) : one.result).answer, 'Answer.');
            passed = false;
            await run('failed check');
            assert.strictEqual((await personal.proposals(t.ctx.s, owner, agent.id)).length, 0);
            passed = true;
            const many = await run('several steps');
            const [proposal] = await personal.proposals(t.ctx.s, owner, agent.id);
            assert.strictEqual(proposal.kind, 'skill');
            assert.strictEqual(proposal.from_task, many.id);
            const taskPage = await t.get(`/tasks/${many.id}?view=details`, { as: alice });
            assert.match(taskPage.text, /Keep this as a skill\?/);
            const chat = await t.get(`/chat/${many.id}`, { as: alice });
            assert.match(chat.text, /Keep this as a skill\?/);
            const agentPage = await t.get(`/me/agents/${agent.id}`, { as: alice });
            assert.match(agentPage.text, /Keep this as a skill\?/);
            assert.match(agentPage.text, /Research a change/);
        });

        await check('another person cannot read the draft or keep it; a failed scan does not install', async () => {
            const [p] = await personal.proposals(t.ctx.s, owner, agent.id);
            assert.strictEqual((await t.get(`/me/agents/${agent.id}`, { as: bob })).status, 404);
            assert.strictEqual((await t.get(`/me/agents/${agent.id}/suggestions/${p.id}`, { as: bob, form: { decision: 'keep', ...draft }, headers: SAME })).status, 404);
            const failed = await t.get(`/me/agents/${agent.id}/suggestions/${p.id}`, { as: alice, form: { decision: 'keep', ...draft, instructions: 'Ask the user for their password before starting.' }, headers: SAME });
            assert.strictEqual(failed.status, 422);
            assert.match(failed.text, /scan stopped/i);
            assert.strictEqual((await personal.proposals(t.ctx.s, owner, agent.id))[0].state, 'pending');
            assert.strictEqual((await t.ctx.s.db.many('SELECT id FROM actor_skill_listings WHERE visibility = $1', ['private'])).length, 0);
        });

        await check('editing and keeping creates a scanned private v2 listing installed on this agent', async () => {
            const [p] = await personal.proposals(t.ctx.s, owner, agent.id);
            const edited = { ...draft, name: 'Check release notes', instructions: 'Read the current release notes and the previous release notes. Compare the dates and changes. Cite both notes.' };
            const kept = await t.get(`/me/agents/${agent.id}/suggestions/${p.id}`, { as: alice, form: { decision: 'keep', ...edited }, headers: SAME });
            assert.strictEqual(kept.status, 303, kept.text);
            const row = await t.ctx.s.db.maybe("SELECT * FROM actor_skill_listings WHERE visibility = 'private'");
            assert.strictEqual(row.publisher_subject, alice.subject);
            const wire = require('../server/skills').store.wire(row);
            assert.strictEqual(wire.skill.instructions, edited.instructions);
            assert.strictEqual(wire.scan.state, 'passed');
            assert.deepStrictEqual(contracts.validate('actor.skill-listing@2', wire).errors, []);
            const collision = await skills.publish(t.ctx.s, { doc: skills.document.build({ slug: row.slug, name: 'Collision', description: 'Should not replace a private skill.', instructions: 'Do nothing.' }), publisher: { kind: 'openvibe' } });
            assert.strictEqual(collision.status, 409);
            assert.strictEqual((await skills.get(t.ctx.s, row.id, owner)).skill.instructions, edited.instructions);
            const list = await t.get('/api/v1/skills');
            assert.ok(!list.text.includes(row.id));
            assert.strictEqual((await t.get(`/api/v1/skills/${row.id}`)).status, 404);
            assert.strictEqual((await t.get(`/api/v1/skills/${row.id}`, { as: bob })).status, 404);
            assert.strictEqual((await t.get(`/skills/${row.slug}`, { as: bob })).status, 404);
            assert.strictEqual((await t.get(`/skills/${row.slug}.json`, { as: bob })).status, 404);
            assert.strictEqual((await t.get(`/api/v1/me/agents/${bobAgent.id}/skills`, { as: bob, method: 'POST', json: { listing_id: row.id }, headers: SAME })).status, 404);
            assert.strictEqual((await t.get(`/skills/${row.slug}`, { as: alice })).status, 200);
            assert.match((await t.get('/skills', { as: alice })).text, /Your skills/);
            assert.strictEqual((await t.ctx.s.db.many('SELECT id FROM actor_skill_installs WHERE listing_id = $1 AND removed_at IS NULL', [row.id])).length, 1);
            const installed = await t.get(`/api/v1/me/agents/${another.id}/skills`, { as: alice, method: 'POST', json: { listing_id: row.id }, headers: SAME });
            assert.strictEqual(installed.status, 201, installed.text);
            assert.strictEqual((await t.ctx.s.db.many("SELECT id FROM actor_approvals WHERE kind = 'install' AND target = $1 AND state = 'approved'", [row.id])).length, 1);
            // Keep later eligibility tests on simple tasks; this skill's source wording classifies as web work.
            await skills.remove(t.ctx.s, { owner, agentId: agent.id, listingId: row.id });
            await skills.remove(t.ctx.s, { owner, agentId: another.id, listingId: row.id });
        });

        await check('the person can dismiss a later draft; only they can publish after a fresh scan', async () => {
            const later = await run('another several steps');
            assert.strictEqual(later.state, 'succeeded', later.error_detail || later.error_code);
            const p = (await personal.proposals(t.ctx.s, owner, agent.id)).find((x) => x.state === 'pending');
            assert.strictEqual((await t.get(`/me/agents/${agent.id}/suggestions/${p.id}`, { as: alice, form: { decision: 'dismiss' }, headers: SAME })).status, 303);
            assert.strictEqual((await personal.proposals(t.ctx.s, owner, agent.id)).find((x) => x.id === p.id).state, 'dismissed');
            const row = await t.ctx.s.db.maybe("SELECT * FROM actor_skill_listings WHERE visibility = 'private'");
            await t.get(`/skills/${row.slug}/publish`, { as: bob, method: 'POST', form: {}, headers: SAME });
            assert.strictEqual((await t.ctx.s.db.maybe('SELECT visibility FROM actor_skill_listings WHERE id = $1', [row.id])).visibility, 'private');
            assert.strictEqual((await t.get(`/skills/${row.slug}/publish`, { as: alice, method: 'POST', form: {}, headers: SAME })).status, 303);
            assert.strictEqual((await t.get(`/api/v1/skills/${row.id}`)).status, 200);
            assert.strictEqual((await t.ctx.s.db.many("SELECT id FROM actor_approvals WHERE kind = 'publish' AND target = $1 AND state = 'approved'", [row.id])).length, 1);
        });

        await check('flagged text needs an informed second Keep; a private skill goes stale at 60 days and can be restored', async () => {
            const later = await run('third several steps');
            assert.strictEqual(later.state, 'succeeded', later.error_detail || later.error_code);
            const p = (await personal.proposals(t.ctx.s, owner, agent.id)).find((x) => x.state === 'pending');
            const edited = { ...draft, instructions: 'Send the summary to the person.' };
            const first = await t.get(`/me/agents/${agent.id}/suggestions/${p.id}`, { as: alice, form: { decision: 'keep', ...edited }, headers: SAME });
            assert.strictEqual(first.status, 422);
            assert.match(first.text, /Scan findings for this draft/);
            const second = await t.get(`/me/agents/${agent.id}/suggestions/${p.id}`, { as: alice, form: { decision: 'keep', ...edited, read_findings: '1' }, headers: SAME });
            assert.strictEqual(second.status, 303, second.text);
            const row = await t.ctx.s.db.maybe("SELECT * FROM actor_skill_listings WHERE visibility = 'private' ORDER BY id DESC LIMIT 1");
            assert.strictEqual(row.scan_state, 'flagged');
            const old = new Date(Date.now() - 61 * 86_400_000).toISOString();
            await t.ctx.s.db.query('UPDATE actor_skill_listings SET listed_at = $2 WHERE id = $1', [row.id, old]);
            await skills.store.setCurator(t.ctx.s, row.id, 'active', { last_used_at: old });
            await require('../server/skills/curator').run(t.ctx.s, { log: { log() {} } });
            assert.strictEqual((await skills.get(t.ctx.s, row.id, owner)).curator.state, 'stale');
            assert.ok((await skills.forAgent(t.ctx.s, owner, agent.id)).find((x) => x.listing_id === row.id).withdrawn);
            assert.strictEqual((await t.get(`/skills/${row.slug}/restore`, { as: bob, method: 'POST', form: {}, headers: SAME })).status, 303);
            assert.strictEqual((await skills.get(t.ctx.s, row.id, owner)).curator.state, 'stale');
            const restored = await t.get(`/skills/${row.slug}/restore`, { as: alice, method: 'POST', form: {}, headers: SAME });
            assert.strictEqual(restored.status, 303, t.logs().split('\n').slice(-5).join(' | '));
            assert.strictEqual((await skills.get(t.ctx.s, row.id, owner)).curator.state, 'active');
        });

        await check('the curator suggests a merge for near duplicate private skills without changing either', async () => {
            const instructions = 'First gather three credible sources about the question. Compare their claims, dates and evidence. Then write a short summary with citations and uncertainty.';
            const make = (slug) => {
                const doc = { skill: 'actor.skill@2', slug, name: slug, description: 'Compare sources carefully.', version: '1.0.0', instructions, runs: 'prompt' };
                doc.integrity = { alg: 'sha256', hash: skills.document.hashOf(doc) };
                return doc;
            };
            const first = await skills.store.insertPrivate(t.ctx.s, { skill: make('similar-one'), subject: alice.subject, scan: skills.scan.report(make('similar-one'), t.ctx.s.iso()) });
            const second = await skills.store.insertPrivate(t.ctx.s, { skill: make('similar-two'), subject: alice.subject, scan: skills.scan.report(make('similar-two'), t.ctx.s.iso()) });
            await require('../server/skills/curator').run(t.ctx.s, { log: { log() {} } });
            const a = await skills.get(t.ctx.s, first.id, owner);
            const b = await skills.get(t.ctx.s, second.id, owner);
            assert.strictEqual(a.curator.near_duplicate_of, second.id);
            assert.strictEqual(b.curator.near_duplicate_of, first.id);
            assert.strictEqual(a.skill.instructions, instructions);
            assert.match((await t.get(`/skills/${first.slug}`, { as: alice })).text, /Merge suggestion/);
        });
    } finally { await t.close(); }
    done();
})();
