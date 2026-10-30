'use strict';
/**
 * Acting tools and resume (Actor v2, stage V2-9 follow-up): a crash inside a tool that changes something must never run
 * it again on its own. The run records the intent before the call and, on resume, goes to needs_you with a card. The
 * three choices do what they say; a read-only call sharing the turn is simply re-run; and the fork dialog names the
 * acting tools the steps after the fork point used.
 *
 * The tools are a fake registry: `robot_steps` acts and hangs on its first call; `read_probe` reads and hangs on its
 * second. The real registry's `acts` values are checked by test/tool-acts.test.js.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, check, done } = require('./helpers/boot');
const store = require('../server/tasks/store');
const { createApp } = require('../server/app');
const { createTask } = require('../server/tasks/create');

const KEY = crypto.randomBytes(32).toString('hex');
const SAME = { 'sec-fetch-site': 'same-origin' };
const quiet = { log() {}, info() {}, warn() {}, error() {} };

function fakeRegistry() {
    const calls = { robot_steps: 0, read_probe: 0 };
    const tools = {
        robot_steps: {
            name: 'robot_steps',
            description: 'Make one of the person\'s robots act.',
            input: { type: 'object', properties: { robot: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } } }, required: ['robot', 'steps'] },
            scope: 'person',
            acts: true,
            timeoutMs: 1000,
            async run() {
                calls.robot_steps += 1;
                // The first call is the one the process dies inside; a deliberate re-run returns.
                if (calls.robot_steps === 1) return new Promise(() => {});
                return { text: 'the robot moved once', data: { moved: true } };
            },
        },
        read_probe: {
            name: 'read_probe',
            description: 'Read a fixture without changing anything.',
            input: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
            scope: 'public',
            async run() {
                calls.read_probe += 1;
                if (calls.read_probe === 2) return new Promise(() => {});
                return { text: 'the fixture was read', data: { read: true } };
            },
        },
    };
    const registry = {
        tools: Object.values(tools),
        byName: new Map(Object.entries(tools)),
        get: (name) => tools[name] || null,
        has: (name) => Boolean(tools[name]),
        definitions: () => Object.values(tools).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input } })),
        run: async (name, input, ctx) => {
            const tool = tools[name];
            if (!tool) return { text: 'unknown tool', isError: true };
            return await tool.run(input, ctx);
        },
        report: () => ({ count: Object.keys(tools).length, names: Object.keys(tools), errors: [] }),
    };
    return { calls, registry };
}

const robotCall = (id = 'r1') => ({ id, type: 'function', function: { name: 'robot_steps', arguments: JSON.stringify({ robot: 'rob_01JZ0000000000000000000RBT', steps: ['forward 1'] }) } });
const readCall = (id = 'p1', path = '/fixture.txt') => ({ id, type: 'function', function: { name: 'read_probe', arguments: JSON.stringify({ path }) } });
const answerTurn = (text) => ({ content: text });
const toolTurn = (text, call) => ({ content: text, tool_calls: [call] });

async function waitFor(fn, ms = 15_000) {
    const until = Date.now() + ms;
    for (;;) {
        const value = await fn();
        if (value) return value;
        if (Date.now() > until) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 25));
    }
}

/** A fresh app on the shared store: each "process" has its own engine and a new checkpoint reader. */
async function processOn(t, registry, models) {
    return await createApp({ config: t.config, store: t.ctx.s, registry, models, log: quiet });
}

async function stopProcess(built) {
    try { await built.ctx.engine.stop(); } catch { /* stopped */ }
    try { await built.ctx.webhooks.stop(); } catch { /* stopped */ }
    try { built.ctx.keys.client.stop(); } catch { /* stopped */ }
    try { if (built.ctx.vibeDelivery) built.ctx.vibeDelivery.stop(); } catch { /* stopped */ }
}

/** Start a task in its own process and stop that process as soon as the wanted checkpoint (or tool call) exists. */
async function startAndCrash(t, { registry, models, task, script, waitFor: ready }) {
    const runner = await processOn(t, registry, models);
    t.providers.reset();
    t.providers.state.script = script;
    const out = await createTask({ s: t.ctx.s, config: t.config, engine: runner.ctx.engine, principal: { requester: `user:${t.user.subject}`, project: null }, body: { task, mode: 'balanced' } });
    if (out.code) throw new Error(`${out.code}: ${out.detail}`);
    const id = out.task.id;
    await waitFor(() => ready(id));
    await runner.ctx.engine.stop();
    const row = await waitFor(async () => {
        const r = await store.getTask(t.ctx.s, id);
        return r && r.state === 'running' ? r : null;
    });
    await stopProcess(runner);
    return { id, row, runner };
}

async function resume(t, registry, models) {
    const built = await processOn(t, registry, models);
    const bootOut = await built.ctx.engine.resumeInterrupted();
    return { built, bootOut };
}

(async () => {
    const { calls, registry } = fakeRegistry();
    const t = await boot({ env: { ACTOR_CHECKPOINT_KEY: KEY }, registry });
    t.user = t.network.addUser('acting');
    const stranger = t.network.addUser('stranger');
    const models = t.ctx.models;
    const owner = `user:${t.user.subject}`;
    try {
        t.config.loop.selfReflections = 0;

        await check('a crash inside robot_steps resumes into needs_you with the acting card, and does not call the tool again', async () => {
            calls.robot_steps = 0;
            const { id } = await startAndCrash(t, {
                registry, models, task: 'Move my rover forward one step.',
                script: [toolTurn('Moving the rover.', robotCall('r1'))],
                waitFor: async (taskId) => {
                    const cp = await t.ctx.checkpoints.last(taskId);
                    return cp && Array.isArray(cp.state.acting) && cp.state.acting.length && calls.robot_steps >= 1 ? cp : null;
                },
            });
            assert.strictEqual(calls.robot_steps, 1, 'the first call started');
            const { built, bootOut } = await resume(t, registry, models);
            try {
                assert.deepStrictEqual(bootOut.resumed, [id]);
                await waitFor(async () => (await store.getTask(t.ctx.s, id)).state === 'needs_you');
                assert.strictEqual(calls.robot_steps, 1, 'resume did not run the acting tool');
                const page = await t.get(`/tasks/${id}`, { as: t.user });
                assert.strictEqual(page.status, 200);
                assert.match(page.text, /Actor was stopped mid-action/);
                assert.match(page.text, /robot steps/);
                assert.match(page.text, /forward 1/);
                assert.match(page.text, /It may or may not have happened/);
                for (const option of ['Run it again', 'It happened, go on', 'Stop the task']) {
                    assert.ok(page.text.includes(`value="${option}"`), `the card offers ${option}`);
                }
                assert.match(page.text, new RegExp(`action="/tasks/${id}/answer"`));
                assert.strictEqual((await t.get(`/tasks/${id}/answer`, { as: stranger, form: { answer: 'Run it again' }, headers: SAME })).status, 404, 'a stranger cannot answer the acting card');
                assert.strictEqual((await t.get(`/tasks/${id}/answer`, { as: t.user, form: { answer: 'Run it again' } })).status, 403, 'the acting form is same-origin');
                const events = await store.eventsAfter(t.ctx.s, id, 0);
                const q = events.find((e) => e.step === 'question');
                assert.ok(q, 'the question event exists');
                assert.strictEqual(q.question_kind, 'acting');
                assert.strictEqual(q.tool, 'robot steps');
                assert.deepStrictEqual(q.options, ['Run it again', 'It happened, go on', 'Stop the task']);
                assert.strictEqual(calls.robot_steps, 1, 'still not run again');
            } finally { await stopProcess(built); }
        });

        await check('"Run it again" deliberately runs the acting tool once, and the task goes on', async () => {
            calls.robot_steps = 0;
            const { id } = await startAndCrash(t, {
                registry, models, task: 'Move my rover forward one step.',
                script: [toolTurn('Moving the rover.', robotCall('r1'))],
                waitFor: async (taskId) => {
                    const cp = await t.ctx.checkpoints.last(taskId);
                    return cp && cp.state.acting && cp.state.acting.length && calls.robot_steps >= 1 ? cp : null;
                },
            });
            const { built } = await resume(t, registry, models);
            try {
                await waitFor(async () => (await store.getTask(t.ctx.s, id)).state === 'needs_you');
                assert.strictEqual(await built.ctx.engine.answer(id, 'Run it again'), true);
                const ended = await waitFor(async () => {
                    const r = await store.getTask(t.ctx.s, id);
                    return ['succeeded', 'failed', 'cancelled'].includes(r.state) ? r : null;
                });
                assert.strictEqual(ended.state, 'succeeded', ended.error_detail || '');
                assert.strictEqual(calls.robot_steps, 2, 'the person chose the one re-run');
                const events = await store.eventsAfter(t.ctx.s, id, 0);
                assert.ok(events.filter((e) => e.step === 'tool_call' && e.tool === 'robot_steps').length >= 1, 'the re-run is on the page');
                assert.ok(events.some((e) => e.step === 'tool_result' && /the robot moved once/.test(String(e.text))), 'its result is on the page');
            } finally { await stopProcess(built); }
        });

        await check('"It happened, go on" records the person\'s word and never runs the tool again', async () => {
            calls.robot_steps = 0;
            const { id } = await startAndCrash(t, {
                registry, models, task: 'Move my rover forward one step.',
                script: [toolTurn('Moving the rover.', robotCall('r1'))],
                waitFor: async (taskId) => {
                    const cp = await t.ctx.checkpoints.last(taskId);
                    return cp && cp.state.acting && cp.state.acting.length && calls.robot_steps >= 1 ? cp : null;
                },
            });
            const { built } = await resume(t, registry, models);
            try {
                await waitFor(async () => (await store.getTask(t.ctx.s, id)).state === 'needs_you');
                assert.strictEqual(await built.ctx.engine.answer(id, 'It happened, go on'), true);
                const ended = await waitFor(async () => {
                    const r = await store.getTask(t.ctx.s, id);
                    return ['succeeded', 'failed', 'cancelled'].includes(r.state) ? r : null;
                });
                assert.strictEqual(ended.state, 'succeeded', ended.error_detail || '');
                assert.strictEqual(calls.robot_steps, 1, 'the acting tool was not run again');
                const result = typeof ended.result === 'string' ? JSON.parse(ended.result) : ended.result;
                const evidence = (result && result.evidence) || [];
                assert.ok(evidence.some((e) => e.tool === 'robot_steps' && /person said it happened/.test(String(e.text))), 'the person-confirmed result is evidence');
                assert.ok((await store.eventsAfter(t.ctx.s, id, 0)).some((e) => e.step === 'tool_result' && /person said it happened/.test(String(e.text))));
            } finally { await stopProcess(built); }
        });

        await check('"Stop the task" ends it cancelled and runs nothing more', async () => {
            calls.robot_steps = 0;
            const { id } = await startAndCrash(t, {
                registry, models, task: 'Move my rover forward one step.',
                script: [toolTurn('Moving the rover.', robotCall('r1'))],
                waitFor: async (taskId) => {
                    const cp = await t.ctx.checkpoints.last(taskId);
                    return cp && cp.state.acting && cp.state.acting.length && calls.robot_steps >= 1 ? cp : null;
                },
            });
            const { built } = await resume(t, registry, models);
            try {
                await waitFor(async () => (await store.getTask(t.ctx.s, id)).state === 'needs_you');
                assert.strictEqual(await built.ctx.engine.answer(id, 'Stop the task'), true);
                const ended = await waitFor(async () => {
                    const r = await store.getTask(t.ctx.s, id);
                    return ['succeeded', 'failed', 'cancelled'].includes(r.state) ? r : null;
                });
                assert.strictEqual(ended.state, 'cancelled');
                assert.strictEqual(calls.robot_steps, 1, 'nothing was run after the stop');
            } finally { await stopProcess(built); }
        });

        await check('a crash inside a read-only call is not a question: it is re-run, and the task goes on', async () => {
            calls.read_probe = 0;
            const { id } = await startAndCrash(t, {
                registry, models, task: 'Read the fixture, then read it once more.',
                script: [toolTurn('Reading once.', readCall('p1', '/one.txt')), toolTurn('Reading again.', readCall('p2', '/two.txt'))],
                waitFor: async (taskId) => {
                    const cp = await t.ctx.checkpoints.list(taskId);
                    return cp.length >= 1 && calls.read_probe >= 2 ? cp : null;
                },
            });
            assert.strictEqual(calls.read_probe, 2, 'the second read started');
            t.providers.state.script = [toolTurn('Reading again after the restart.', readCall('p2', '/two.txt')), answerTurn('The fixture was read twice.')];
            const { built } = await resume(t, registry, models);
            try {
                const ended = await waitFor(async () => {
                    const r = await store.getTask(t.ctx.s, id);
                    return ['succeeded', 'failed', 'cancelled'].includes(r.state) ? r : null;
                });
                assert.strictEqual(ended.state, 'succeeded', ended.error_detail || '');
                assert.ok(calls.read_probe >= 3, `the read ran again after the crash (${calls.read_probe})`);
                const events = await store.eventsAfter(t.ctx.s, id, 0);
                assert.ok(!events.some((e) => e.step === 'question'), 'a read-only call is not a question');
                assert.ok(events.filter((e) => e.step === 'tool_result' && e.tool === 'read_probe').length >= 2, 'the read result is recorded again');
            } finally { await stopProcess(built); }
        });

        await check('the fork dialog lists the acting tools used after the fork point', async () => {
            calls.robot_steps = 0;
            calls.read_probe = 0;
            const { id } = await startAndCrash(t, {
                registry, models, task: 'Read the fixture, then move the rover.',
                script: [toolTurn('Reading first.', readCall('p1', '/one.txt')), toolTurn('Moving the rover.', robotCall('r1'))],
                waitFor: async (taskId) => {
                    const cp = await t.ctx.checkpoints.last(taskId);
                    return cp && cp.state.acting && cp.state.acting.length && calls.robot_steps >= 1 ? cp : null;
                },
            });
            const { built } = await resume(t, registry, models);
            try {
                await waitFor(async () => (await store.getTask(t.ctx.s, id)).state === 'needs_you');
                assert.strictEqual(await built.ctx.engine.answer(id, 'It happened, go on'), true);
                const ended = await waitFor(async () => {
                    const r = await store.getTask(t.ctx.s, id);
                    return ['succeeded', 'failed', 'cancelled'].includes(r.state) ? r : null;
                });
                assert.strictEqual(ended.state, 'succeeded', ended.error_detail || '');
                const page = await t.get(`/tasks/${id}/fork?step=1`, { as: t.user });
                assert.strictEqual(page.status, 200);
                assert.match(page.text, /A fork can do these again:/);
                assert.match(page.text, /robot_steps/);
                assert.match(page.text, /check them yourself after the fork/);
            } finally { await stopProcess(built); }
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
