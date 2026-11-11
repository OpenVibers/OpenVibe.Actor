'use strict';
const assert = require('assert');
const { initial, createMapper, titleFor, sourcesIn } = require('../server/agent-ui/mapper');
const { clean: stripSecrets } = require('../server/agent-ui/redact');
const { createRunStream } = require('../server/agent-ui/service');
const { createActorRuns } = require('../server/agent-ui/actor');
const { boot, check, done } = require('./helpers/boot');
(async () => {
    await check('titles, groups, summaries, full results and deduplicated sources', async () => {
        assert.equal(titleFor('Read', { file_path: 'server/auth/handoff.js' }).title, 'Read server/auth/handoff.js');
        assert.equal(titleFor('WebFetch', { url: 'https://docs.ag-ui.com/spec' }).title, 'Fetched docs.ag-ui.com');
        assert.equal(sourcesIn('[AG-UI](https://docs.ag-ui.com/) https://docs.ag-ui.com/').length, 1);
        const state = initial('run1', 'actor', '2026-11-11T00:00:00Z');
        const m = createMapper(state, { clean: stripSecrets });
        await m.push({ t: 'tool', id: 'one', name: 'Read', input: { path: 'one.js' } }, 1);
        await m.push({ t: 'tool_result', id: 'one', output: 'line\n'.repeat(1000) }, 2);
        await m.push({ t: 'tool', id: 'two', name: 'Read', input: { path: 'two.js' } }, 3);
        assert.equal(state.steps[0].group_id, state.steps[1].group_id);
        assert.equal(state.steps[1].group_count, 2);
        assert.equal(m.events.find((e) => e.event.type === 'TOOL_CALL_RESULT').event.content.length, 5000);
        assert(!state.steps[0].summary.includes('\n'));
        await m.push({ t: 'text', text: 'Next.' }, 4);
        await m.push({ t: 'tool', id: 'three', name: 'Read', input: { path: 'three.js' } }, 5);
        assert.notEqual(state.steps[1].group_id, state.steps[2].group_id);
        await m.push({ t: 'end', ok: false }, 6);
        assert.equal(m.events.at(-1).event.type, 'RUN_ERROR');
    });
    const t = await boot({ env: { ACTOR_AGENT_UI: '1' } });
    try {
        const owner = t.network.addUser('agui-owner'), other = t.network.addUser('agui-other');
        const r = await t.get('/api/v1/tasks', { as: owner, json: { task: 'Say hello.' }, headers: { 'sec-fetch-site': 'same-origin' } });
        assert.equal(r.status, 201, r.text);
        const id = r.json().id;
        const row = await t.waitFor(id);
        const runs = createActorRuns({ s: t.ctx.s });
        const selected = await runs.resolve(row);
        const concurrent = await Promise.all([runs.snapshot(selected), runs.snapshot(selected)]);
        assert.deepEqual(concurrent[0], concurrent[1]);
        const paged = createRunStream({ store: t.ctx.s, product: 'actor', clean: stripSecrets, read: async (_id, after) => ({ items: Array.from({ length: Math.max(0, Math.min(500, 501 - after)) }, (_, i) => ({ seq: after + i + 1, line: { t: 'text', text: 'page' } })), ended: after >= 500, ok: true }) });
        const pages = await paged.project({ ...row, run_id: id + '~page-test' });
        assert.equal(pages.source, 501);
        assert.equal(pages.terminal, true);
        await check('owner snapshot; stranger and anonymous get existing access refusals', async () => {
            const got = await t.get(`/api/v1/runs/${id}`, { as: owner });
            assert.equal(got.status, 200, got.text);
            assert(got.json().id.startsWith(id));
            assert.equal((await t.get(`/api/v1/runs/${id}`, { as: other })).status, 404);
            assert.equal((await t.get(`/api/v1/runs/${id}/events`, { as: other })).status, 404);
            assert.equal((await t.get(`/api/v1/runs/${id}`)).status, 401);
        });
        await check('SSE closes, counters persist, Last-Event-ID resumes exactly', async () => {
            const a = await t.get(`/api/v1/runs/${id}/events`, { as: owner });
            assert.equal(a.status, 200, a.text);
            const ids = [...a.text.matchAll(/^id: (\d+)$/gm)].map((m) => +m[1]);
            assert(ids.length > 2);
            assert.match(a.text, /event: RUN_STARTED/);
            assert.match(a.text, /event: RUN_(FINISHED|ERROR)/);
            const after = ids[Math.floor(ids.length / 2)];
            const b = await t.get(`/api/v1/runs/${id}/events`, { as: owner, headers: { 'Last-Event-ID': String(after) } });
            assert.deepEqual([...b.text.matchAll(/^id: (\d+)$/gm)].map((m) => +m[1]), ids.filter((n) => n > after));
            const c = await t.get(`/api/v1/runs/${id}/events`, { as: owner });
            assert.equal(a.text, c.text);
            const bad = await t.get(`/api/v1/runs/${id}/events`, { as: owner, headers: { 'Last-Event-ID': 'NaN' } });
            assert.equal(bad.status, 400);
        });
        await check('owner switch off hides the endpoints', async () => {
            t.config.agentUi = false;
            t.config.agentUiSetting = () => false;
            assert.equal((await t.get(`/api/v1/runs/${id}`, { as: owner })).status, 404);
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
