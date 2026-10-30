'use strict';
/**
 * Tracing (Actor v2, stage V2-10): a span for every model, tool, check and delegate call, with a parent link under a
 * sub-agent's delegate span; no text in a span; a failed span insert never fails the task; the trace API is the
 * task's own; and the live stats are one aggregate with the public n >= 20 floor.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { createStats } = require('../server/runtime/stats');
const taskStore = require('../server/tasks/store');

const SAME = { 'sec-fetch-site': 'same-origin' };
const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

async function taskFor(t, user, text = 'What is 2 + 2?', extra = {}) {
    const res = await t.get('/api/v1/tasks', { as: user, json: { task: text, ...extra }, headers: SAME });
    assert.strictEqual(res.status, 201, res.text);
    return res.json().id;
}

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const bo = t.network.addUser('bo');
    t.config.loop.selfReflections = 0;
    const s = t.ctx.s;
    let firstTaskId = null;

    try {
        await check('a span for the model, the tool and the check, with the model id and the tool name', async () => {
            t.providers.state.script = [
                { content: 'Working it out.', tool_calls: [toolCall('c1', 'calculate', { expression: '2+2' })] },
                { content: 'The result is **4** [E1].' },
            ];
            const id = await taskFor(t, kim, 'ZZTOP_SECRET_TASK What is 2 + 2?');
            firstTaskId = id;
            const row = await t.waitFor(id);
            assert.strictEqual(row.state, 'succeeded');
            const spans = await s.db.many('SELECT * FROM actor_spans WHERE task_id = $1 ORDER BY started_at, id', [id]);
            const kinds = new Set(spans.map((x) => x.kind));
            assert.ok(kinds.has('model'), 'a model span');
            assert.ok(kinds.has('tool'), 'a tool span');
            assert.ok(kinds.has('check'), 'a check span');
            const model = spans.find((x) => x.kind === 'model');
            const tool = spans.find((x) => x.kind === 'tool');
            assert.match(String(model.name), /deepseek|gpt|stand-in|fake/i, 'the model id, not a message');
            assert.strictEqual(tool.name, 'calculate');
            assert.ok(Number(tool.ms) >= 0 && Number(tool.cost_usd) >= 0);
            assert.strictEqual(tool.ok, true);
        });

        await check('a span is numbers and names only: no prompt, tool input/output or user text, and no text column', async () => {
            const id = firstTaskId;
            const spans = await s.db.many('SELECT * FROM actor_spans WHERE task_id = $1', [id]);
            assert.ok(spans.length, 'the task has spans');
            const dump = JSON.stringify(spans);
            assert.ok(!dump.includes('ZZTOP_SECRET_TASK'), 'the task text is not in any span');
            const cols = await s.db.many("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'actor_spans'");
            const names = cols.map((c) => c.column_name);
            for (const forbidden of ['prompt', 'input', 'output', 'text', 'body', 'content', 'message', 'tool_input', 'tool_output']) {
                assert.ok(!names.includes(forbidden), `no ${forbidden} column on a span`);
            }
            assert.deepStrictEqual(names.sort(), ['cost_usd', 'error_code', 'family', 'id', 'kind', 'ms', 'name', 'ok', 'parent_id', 'started_at', 'step', 'task_id', 'tier', 'tokens_in', 'tokens_out'].sort());
        });

        await check('a sub-agent\'s spans hang under its delegate span', async () => {
            t.providers.state.script = [
                { content: 'Delegating the arithmetic.', tool_calls: [toolCall('d1', 'delegate', { goal: 'Compute 2+2', tools: ['calculate'] })] },
                { content: 'Computing.', tool_calls: [toolCall('c1', 'calculate', { expression: '2+2' })] },
                { content: 'It is 4 [E1].' },
                { content: 'Both parts agree: **4** [E1].' },
            ];
            const id = await taskFor(t, kim, 'Compare two ways of doing 2+2', { mode: 'best' });
            const row = await t.waitFor(id);
            assert.strictEqual(row.state, 'succeeded', row.error_detail);
            const spans = await s.db.many('SELECT * FROM actor_spans WHERE task_id = $1', [id]);
            const delegate = spans.find((x) => x.kind === 'delegate');
            assert.ok(delegate, 'a delegate span');
            const children = spans.filter((x) => x.parent_id === delegate.id);
            assert.ok(children.some((x) => x.kind === 'model'), 'the child model call hangs under it');
            assert.ok(children.some((x) => x.kind === 'tool' && x.name === 'calculate'), 'the child tool call hangs under it');
            assert.ok(!spans.some((x) => x.kind === 'model' && x.parent_id && !children.some((c) => c.id === x.id)), 'no orphan child span');
        });

        await check('the trace API is the task\'s own: the owner reads it, another person gets 404', async () => {
            const id = (await s.db.many('SELECT id FROM tasks WHERE requester = $1 ORDER BY created_at DESC LIMIT 1', [`user:${kim.subject}`]))[0].id;
            const own = await t.get(`/api/v1/tasks/${id}/trace`, { as: kim });
            assert.strictEqual(own.status, 200, own.text);
            const body = own.json();
            assert.strictEqual(body.task_id, id);
            assert.ok(Array.isArray(body.spans) && body.spans.length);
            assert.ok(body.totals && Number.isFinite(body.totals.model_cost_usd) && Number.isFinite(body.totals.ms));
            assert.strictEqual((await t.get(`/api/v1/tasks/${id}/trace`, { as: bo })).status, 404);
        });

        await check('a span insert failure is logged once and the task still finishes', async () => {
            const db = s.db;
            const orig = db.query;
            db.query = async (sql, ...args) => {
                if (/INSERT INTO actor_spans/.test(String(sql))) throw new Error('stand-in trace insert failure');
                return orig.call(db, sql, ...args);
            };
            t.providers.state.script = [
                { content: 'Working.', tool_calls: [toolCall('c1', 'calculate', { expression: '2+2' })] },
                { content: 'The result is **4** [E1].' },
            ];
            try {
                const id = await taskFor(t, kim, 'What is 2 + 2 again?');
                const row = await t.waitFor(id);
                assert.strictEqual(row.state, 'succeeded', 'the trace failure did not fail the task');
                assert.strictEqual(await s.db.value('SELECT count(*)::int FROM actor_spans WHERE task_id = $1', [id]), 0);
                assert.match(t.logs(), /trace span not stored \(the task goes on\)/);
            } finally {
                db.query = orig;
            }
        });

        await check('the live stats: the maths over the last 7 days, and the n >= 20 public floor', async () => {
            const owner = `user:${kim.subject}`;
            const id = s.newId('tsk');
            await taskStore.insertTask(s, { id, requester: owner, task: 'stats fixture', mode: 'balanced', budget_task: 0.05, budget_day: 0.25, created_at: s.iso() });
            const at = (i) => new Date(Date.now() - (i + 1) * 1000).toISOString();
            const insert = (kind, name, ms, cost, ok, i) => s.db.query(
                `INSERT INTO actor_spans (id, task_id, kind, name, started_at, ms, cost_usd, ok, error_code, step)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)`,
                [s.newId('spn'), id, kind, name, at(i), ms, cost, ok, ok ? null : 'actor.tool.failed'],
            );
            for (let i = 0; i < 20; i++) await insert('tool', 'tool_popular', 100, 0.001, true, i);
            await insert('tool', 'tool_popular', 300, 0.002, false, 20);       // the one failure
            for (let i = 0; i < 19; i++) await insert('tool', 'tool_rare', 50, 0.0005, true, i);
            for (let i = 0; i < 20; i++) await insert('model', 'deepseek:deepseek-flash', 200, 0.003, true, i);

            const stats = createStats({ store: s, log: { warn() {} } });
            const tool = await stats.forTool('tool_popular');
            assert.strictEqual(tool.n, 21);
            assert.strictEqual(Math.round(tool.successRate * 1000) / 1000, Math.round((20 / 21) * 1000) / 1000);
            assert.strictEqual(tool.p50ms, 100);
            assert.strictEqual(tool.p90ms, 100);
            assert.strictEqual(tool.meanCostUsd, Math.round((((20 * 0.001) + 0.002) / 21) * 1e8) / 1e8);
            assert.ok(tool.lastFailureAt, 'the last failure is dated');
            const rare = await stats.forTool('tool_rare');
            assert.strictEqual(rare.n, 19);
            const model = await stats.forModel('deepseek:deepseek-flash');
            assert.strictEqual(model.n, 20);
            assert.strictEqual(model.p50ms, 200);
            assert.strictEqual((await stats.forTool('nope')).n, 0);

            const withFloor = await stats.publicTools();
            assert.ok(withFloor.some((x) => x.name === 'tool_popular'), 'n=21 is public');
            assert.ok(!withFloor.some((x) => x.name === 'tool_rare'), 'n=19 is not public');
            assert.ok(withFloor.every((x) => Object.keys(x).sort().join(',') === 'lastFailureAt,meanCostUsd,n,name,p50ms,p90ms,successRate'), 'a name and its numbers only');

            // The app's own stats instance (used by the API) has not cached yet; it reads the same table.
            t.ctx.stats.clear();
            const api = await t.get('/api/v1/stats/tools');
            assert.strictEqual(api.status, 200);
            assert.ok(api.json().tools.some((x) => x.name === 'tool_popular'));
            assert.ok(!api.json().tools.some((x) => x.name === 'tool_rare'));
            const models = await t.get('/api/v1/stats/models');
            assert.ok(models.json().models.some((x) => x.name === 'deepseek:deepseek-flash'));
            assert.ok(!JSON.stringify(api.json()).includes(id), 'no task id in the public numbers');
        });

        await check('the task page has a closed Trace fold: rows indented, failed in words, totals, at most one phone screen', async () => {
            const id = firstTaskId;
            await s.db.query(
                `INSERT INTO actor_spans (id, task_id, kind, name, started_at, ms, cost_usd, ok, error_code, step)
                 VALUES ($1, $2, 'tool', 'read_page', $3, 321, 0.0002, false, 'actor.tool.failed', 2)`,
                [s.newId('spn'), id, new Date().toISOString()],
            );
            for (let i = 0; i < 30; i++) {
                await s.db.query(
                    `INSERT INTO actor_spans (id, task_id, kind, name, started_at, ms, cost_usd, ok, step)
                     VALUES ($1, $2, 'tool', 'search_web', $3, 40, 0.0001, true, 3)`,
                    [s.newId('spn'), id, new Date(Date.now() + i + 1).toISOString()],
                );
            }
            const total = await s.db.value('SELECT count(*)::int FROM actor_spans WHERE task_id = $1', [id]);
            assert.ok(total > 12, 'more spans than fit');
            const page = await t.get(`/tasks/${id}`, { as: kim });
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('<details class="trace" id="trace">'), 'a trace fold, closed by default');
            assert.ok(!/<details class="trace" id="trace" open/.test(page.text));
            assert.strictEqual((page.text.match(/<li class="tr /g) || []).length, 12, 'twelve rows at most');
            assert.ok(page.text.includes('<span class="tr-bad">failed</span>'), 'a failed span says so in words');
            assert.ok(page.text.includes(`And ${total - 12} more calls in`), 'the rest is the API');
            assert.ok(/<p class="trace-tot"><span>Model \$[\d.]+<\/span><span>Tools \$[\d.]+<\/span><span>Time [^<]+<\/span><\/p>/.test(page.text), 'totals: model cost, tool cost, time');
            assert.ok(page.text.includes('Read a page') && page.text.includes('Web search'), 'names as people read them');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
