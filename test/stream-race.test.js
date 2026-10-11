'use strict';
/**
 * A task stream reader gets every event once, in seq order, even when the engine publishes (and ends the task) while
 * the reader's backlog is still being read. Before the fix, an `end` published during the backlog read was sent first,
 * so every older backlog event counted as already sent: the reader saw only seq 9 (CI on PostgreSQL, 2026-10-11).
 */
const assert = require('assert');
const { EventEmitter } = require('events');
const { createTaskStream } = require('../server/tasks/stream');

function fakeRes() {
    return {
        chunks: [], ended: false,
        status() { return this; }, set() { return this; }, flushHeaders() {},
        write(c) { this.chunks.push(c); }, end() { this.ended = true; },
        seqs() { return this.chunks.join('').split('\n').filter((l) => l.startsWith('id: ')).map((l) => Number(l.slice(4))); },
    };
}
const ev = (seq, kind = 'output') => ({ task_id: 'tsk_1', seq, kind });

(async () => {
    const stream = createTaskStream({ log: { warn() {} } });

    // 1. The task ends while the backlog read is in flight: the late `end` waits, the backlog goes first, then the stream closes.
    {
        let release;
        const gate = new Promise((r) => { release = r; });
        const res = fakeRes();
        const serving = stream.serve(new EventEmitter(), res, {
            taskId: 'tsk_1', after: 0,
            readBacklog: async () => { await gate; return [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ev(n)); },
            isEnded: async () => true,
        });
        stream.publish('tsk_1', ev(9, 'end'));
        stream.end('tsk_1');
        assert.ok(!res.ended, 'the stream stays open until its backlog is out');
        release();
        await serving;
        assert.deepStrictEqual(res.seqs(), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
        assert.ok(res.ended);
    }

    // 2. Events published during the backlog read that the backlog also holds are sent once; newer ones follow in order.
    {
        let release;
        const gate = new Promise((r) => { release = r; });
        const res = fakeRes();
        const serving = stream.serve(new EventEmitter(), res, {
            taskId: 'tsk_2', after: 2,
            readBacklog: async () => { await gate; return [3, 4].map((n) => ({ ...ev(n), task_id: 'tsk_2' })); },
            isEnded: async () => false,
        });
        stream.publish('tsk_2', { ...ev(5), task_id: 'tsk_2' });
        stream.publish('tsk_2', { ...ev(4), task_id: 'tsk_2' });
        release();
        await serving;
        stream.publish('tsk_2', { ...ev(6, 'end'), task_id: 'tsk_2' });
        assert.deepStrictEqual(res.seqs(), [3, 4, 5, 6], 'after Last-Event-ID 2: each seq once, in order');
        assert.ok(!res.ended, 'not ended until the engine ends it');
        stream.end('tsk_2');
        assert.ok(res.ended);
        assert.deepStrictEqual(stream.status(), { streams: 0 });
    }
    console.log('stream-race: ok');
})().catch((e) => { console.error(e); process.exit(1); });
