'use strict';
const assert = require('node:assert/strict');
const { boot } = require('./helpers/boot');
const personal = require('../server/agents/personal');
const bindings = require('../server/agents/channel-bindings');

(async () => {
    const t = await boot();
    try {
        const who = t.network.addUser('channels');
        const owner = `user:${who.subject}`;
        const make = async name => (await personal.create(t.ctx.s, t.config, owner, {
            name, instructions: `Instructions for ${name}.`, mode: 'balanced', budget_per_run_usd: 0.02,
            daily_runs_max: 5, schedule: 'off', status: 'active',
        })).row;
        const work = await make('Work');
        const family = await make('Family');
        await bindings.ensure(t.ctx.s, { kind: 'telegram', accountId: '2048', owner, label: '@work', agentId: work.id });
        let page = await t.get(`/me/agents/${family.id}`, { as: who });
        assert.equal(page.status, 200);
        assert.match(page.text, /Where it listens/);
        assert.match(page.text, /Currently on Work/);
        assert.match(page.text, /Move here/);
        const url = `/me/agents/${family.id}/channels/telegram/2048`;
        let response = await t.get(`${url}/bind`, { as: who, method: 'POST', form: {}, headers: { origin: t.config.baseUrl } });
        assert.equal(response.status, 303);
        assert.match(response.headers.get('location'), /channel=moved/);
        assert.equal((await bindings.get(t.ctx.s, 'telegram', '2048')).agent_id, family.id);
        page = await t.get(`/me/agents/${family.id}?channel=moved`, { as: who });
        assert.match(page.text, /This account now goes to Family/);
        assert.match(page.text, /Unbind/);
        response = await t.get(`${url}/unbind`, { as: who, method: 'POST', form: {}, headers: { origin: t.config.baseUrl } });
        assert.equal(response.status, 303);
        assert.equal((await bindings.get(t.ctx.s, 'telegram', '2048')).agent_id, null);
        const outsider = t.network.addUser('outsider');
        response = await t.get(`${url}/bind`, { as: outsider, method: 'POST', form: {}, headers: { origin: t.config.baseUrl } });
        assert.equal(response.status, 404);
        assert.equal((await bindings.get(t.ctx.s, 'telegram', '2048')).agent_id, null);
    } finally { await t.close(); }
    process.stdout.write('channel bindings page passed\n');
})().catch(err => { process.stderr.write(`${err.stack || err}\n`); process.exitCode = 1; });
