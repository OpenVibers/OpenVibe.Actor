'use strict';
/**
 * The task page, polished (Actor v2, after V2-9): the brain's ledger shows each labelled value on its own line, with no
 * dangling separator after it, and a task stopped mid-action says it once — the acting card, then a short "Waiting for
 * you" box that keeps only the Cancel button and what the task does while the person decides.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const store = require('../server/tasks/store');
const taskEvents = require('../public/js/task-events');

const PLAN = '→ 1. Move the rover forward one step\nTask ledger: given the rover · find nothing · derive the move\nProgress: not done; not looping; moving; next Move the rover forward one step';

/** The ledger's lines as a person reads them: the label and its value, without the markup. */
function ledgerLines(page) {
    const block = /<div class="plan-ledger"[^>]*>([\s\S]*?)<\/div>/.exec(page);
    assert.ok(block, 'the page has a ledger');
    return block[1]
        .split('</p>')
        .map((chunk) => chunk.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
}

/** The "Waiting for you" box on its own. */
function waitingBox(page) {
    const box = /<section class="outcome outcome-wait"[^>]*>([\s\S]*?)<\/section>/.exec(page);
    assert.ok(box, 'the page has a waiting box');
    return box[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A task that waits for its person, with the brain's ledgers on its plan card. */
async function waitingTask(s, requester, at, { acting = false } = {}) {
    const id = s.newId('tsk');
    await store.insertTask(s, { id, requester, task: 'Move my rover forward one step.', mode: 'balanced', budget_task: 0.05, budget_day: 0.25, created_at: at });
    await store.updateTask(s, id, { state: 'needs_you', cost_usd: 0.0004 });
    await store.appendEvent(s, id, { at, kind: 'output', step: 'plan', agent: 'openvibe-runtime', text: PLAN });
    if (acting) {
        await store.appendEvent(s, id, {
            at, kind: 'output', step: 'question', agent: 'openvibe-runtime', question_kind: 'acting', tool: 'robot steps', input: 'rover: forward 1',
            text: 'Actor was stopped while it was robot steps (rover: forward 1). It may or may not have happened. Check, then choose.',
            options: ['Run it again', 'It happened, go on', 'Stop the task'],
        });
    } else {
        await store.appendEvent(s, id, {
            at, kind: 'output', step: 'question', agent: 'openvibe-runtime',
            text: 'Which city?', options: ['Lisbon', 'Porto'],
        });
    }
    await store.appendEvent(s, id, { at, kind: 'state', state: 'needs_you' });
    return id;
}

(async () => {
    const t = await boot();
    try {
        const u = t.network.addUser('polish');
        const s = t.ctx.s;
        const at = s.iso();
        const requester = `user:${u.subject}`;
        const actingId = await waitingTask(s, requester, at, { acting: true });
        const askedId = await waitingTask(s, requester, at);

        await check('the ledger of a waiting task shows each value only: no line ends in a separator', async () => {
            const page = await t.get(`/tasks/${actingId}`, { as: u });
            assert.strictEqual(page.status, 200);
            const lines = ledgerLines(page.text);
            assert.ok(lines.length >= 6, `the ledger has its lines (${lines.length})`);
            for (const line of lines) {
                assert.ok(!/\u00b7\s*$/.test(line), `no dangling separator: "${line}"`);
                assert.ok(!/\u00b7/.test(line), `no separator at all: "${line}"`);
            }
            assert.ok(lines.some((l) => l === 'Done: no'), 'the ledger says whether it is done');
            assert.ok(lines.some((l) => l === 'Stuck: no'), 'and whether it is stuck');
            assert.ok(lines.some((l) => l === 'Next: Move the rover forward one step'), 'and what is next');
        });

        await check('the ledger formatter gives every label its own value', async () => {
            const rows = taskEvents.progressRows({ done: false, looping: false, progressing: true, stuck: false, next: null, stopped: null });
            assert.deepStrictEqual(rows.map((r) => `${r.label} ${r.value}`), ['Done: no', 'Stuck: no', 'Next: none']);
            for (const row of rows) assert.ok(!/\u00b7/.test(row.value), 'a value carries no separator');
            const stopped = taskEvents.progressRows({ done: true, progressing: true, stuck: false, next: null, stopped: 'the check failed' });
            assert.deepStrictEqual(stopped.map((r) => `${r.label} ${r.value}`), ['Done: yes', 'Stuck: no', 'Next: none', 'Stopped: the check failed']);
        });

        await check('a task stopped mid-action says it once: the card, then a short waiting box', async () => {
            const page = await t.get(`/tasks/${actingId}`, { as: u });
            assert.strictEqual(page.status, 200);
            assert.match(page.text, /Actor was stopped mid-action/);
            for (const option of ['Run it again', 'It happened, go on', 'Stop the task']) {
                assert.ok(page.text.includes(`value="${option}"`), `the card offers ${option}`);
            }
            const box = waitingBox(page.text);
            assert.ok(/The task keeps its place and its budget while you decide\./.test(box), 'the box keeps the budget line');
            assert.ok(/Cancel/.test(box), 'the box keeps the Cancel button');
            assert.ok(!/doing something that may have happened/.test(box), 'the box does not repeat the acting card');
            assert.ok(!/Check it yourself/.test(box), 'the box does not repeat the acting card');
            assert.ok(!/choose above/.test(box), 'the box does not repeat the acting card');
        });

        await check('another reason to wait keeps its box as it was', async () => {
            const page = await t.get(`/tasks/${askedId}`, { as: u });
            assert.strictEqual(page.status, 200);
            const box = waitingBox(page.text);
            assert.ok(/Actor asked one question before spending anything on this task\./.test(box), 'the question box is as it was');
            assert.ok(/Cancel/.test(box), 'the box keeps the Cancel button');
            assert.ok(/The task keeps its place and its budget while you decide\./.test(page.text), 'the waiting note is as it was');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
