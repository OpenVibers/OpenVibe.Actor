'use strict';

/**
 * Wait for something, without spending anything (plan A2, Watch mode).
 *
 * The tool writes a wait row and parks the run: the model stops calling, the desk is released and the budget
 * clock stops, and the task keeps its place. It comes back when a matching event arrives (a Codes task on a
 * repository ended, a Run job ended) or when the deadline passes.
 *
 * The tool never names the task, the person, the budget or the permissions: it takes them from the run that
 * called it (the loop's context). A wait is therefore only ever created by the task's own run, for the person
 * that run belongs to.
 *
 * What the model may not do is decide that the wait is over: the wait ends on an event or on the deadline, and
 * the event's payload is untrusted input that reaches the next turn as data.
 */
const { personOf } = require('./_openvibe');

const SOURCES = ['codes', 'run', 'time'];

module.exports = {
    name: 'wait_for',
    description: 'Wait for something to happen without spending anything while you wait. Use it when the answer depends on something that is still running (a coding task on the person\'s own machine, a job in the cloud) or when you should simply look again later. The task keeps its place, its budget and its plan; no model runs until the event arrives or the deadline passes. Say the source, what to wait for, how long at most, and the short line the person should read.',
    input: {
        type: 'object',
        properties: {
            source: { type: 'string', enum: SOURCES, description: 'codes: a coding task on a repository; run: a job in the cloud; time: just some time' },
            repo: { type: 'string', description: 'owner/name of the repository, for source "codes"' },
            job_id: { type: 'string', description: 'the job id (job_…), for source "run"' },
            seconds: { type: 'number', description: 'how long to wait at most, in seconds (the deadline)' },
            on_timeout: { type: 'string', enum: ['ask', 'retry', 'fail'], description: 'what to do when nothing happened: ask the person, try that step again once, or fail the task' },
            line: { type: 'string', description: 'the short line the person reads, e.g. "waiting for your Codes task on owner/repo to finish"' },
        },
        required: ['source', 'seconds'],
    },
    scope: 'person',
    acts: false,
    costUsd: 0,
    timeoutMs: 30_000,
    available: (ctx) => Boolean(ctx && ctx.waits && ctx.requester && personOf(ctx.requester)),
    async run(input, ctx) {
        const waits = ctx.waits;
        if (!waits) return { text: JSON.stringify({ error: 'waiting is not available here' }), isError: true };
        const person = personOf(ctx.requester);
        if (!person) return { text: JSON.stringify({ error: 'a wait needs a person to wait for' }), isError: true };
        const source = String(input.source || '');
        if (!SOURCES.includes(source)) {
            return { text: JSON.stringify({ error: `source must be one of ${SOURCES.join(', ')}` }), isError: true };
        }
        const target = source === 'codes' ? String(input.repo || '') : source === 'run' ? String(input.job_id || '') : null;
        const seconds = Number(input.seconds);
        if (!Number.isFinite(seconds) || seconds <= 0) {
            return { text: JSON.stringify({ error: 'seconds must be how long to wait (a positive number of seconds)' }), isError: true };
        }
        let row;
        try {
            row = await waits.create({
                taskId: ctx.taskId,
                requester: ctx.requester,
                source,
                target,
                seconds,
                onTimeout: String(input.on_timeout || 'ask'),
                line: input.line || null,
                // The run's own trace: an event that carries it came from this run's own action.
                traceId: ctx.trace && typeof ctx.trace.newId === 'function' ? ctx.trace.newId() : null,
                step: ctx.step == null ? null : ctx.step,
            });
        } catch (err) {
            const code = err && err.code ? err.code : 'actor.wait.failed';
            return { text: JSON.stringify({ error: String((err && err.message) || err).slice(0, 300), code }), isError: true };
        }
        const until = new Date(row.deadline_at).toISOString();
        return {
            text: JSON.stringify({ waiting: true, line: row.line, deadline_at: until, on_timeout: row.on_timeout, wait_id: row.id }),
            data: { wait_id: row.id, line: row.line, deadline_at: until },
            // The park marker: the loop stops here, with no model running, until the event or the deadline.
            park: { wait_id: row.id },
        };
    },
};
