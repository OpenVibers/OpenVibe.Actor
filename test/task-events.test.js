'use strict';
// The task page's event mapping (public/js/task-events.js): a search's result lands on its call, a call a finished
// task never answered settles as done instead of spinning forever, identical consecutive calls fold into one line
// with a count, and the run's time is the task's own (first event → last event).
const assert = require('assert');
const { lines, firstAt, duration } = require('../public/js/task-events');

const at = (s) => `2026-10-30T10:00:${s}.000Z`;
const call = (input, s, extra) => ({ kind: 'output', step: 'tool_call', tool: 'web_search', input, at: at(s), agent: 'openai-agent', ...extra });
const result = (text, s, extra) => ({ kind: 'output', step: 'tool_result', tool: 'web_search', text, at: at(s), agent: 'openai-agent', ...extra });
const text = (t, s) => ({ kind: 'output', step: 'text', text: t, at: at(s), agent: 'openai-agent' });
const end = (state, s) => ({ kind: 'end', state, at: at(s) });

// A finished hosted search: both calls are answered, the repeated one folds into "×2", the sources are in the result.
{
    const events = [
        text('Searching the web…', '00'),
        call('Eiffel Tower height', '02'), result('Searched the web for "Eiffel Tower height". The answer cites 1 source:\n- https://en.wikipedia.org/wiki/Eiffel_Tower', '04'),
        call('Eiffel Tower height', '05'), result('Searched the web for "Eiffel Tower height". The answer cites 1 source:\n- https://en.wikipedia.org/wiki/Eiffel_Tower', '07'),
        text('The Eiffel Tower is **330 m** tall.', '08'),
        end('succeeded', '09'),
    ];
    const out = lines(events, { final: true, state: 'succeeded' });
    const tools = out.filter((l) => l.t === 'tool');
    const results = out.filter((l) => l.t === 'tool_result');
    const done = out.filter((l) => l.t === 'done');
    assert.strictEqual(tools.length, 1, 'identical consecutive calls fold into one line');
    assert.strictEqual(tools[0].what, 'Eiffel Tower height ×2');
    assert.deepStrictEqual(tools[0].input, { description: 'Eiffel Tower height ×2' });
    assert.strictEqual(results.length, 1, 'the folded call does not leave a second result');
    assert.strictEqual(results[0].id, tools[0].id, 'a result lands on its own call');
    assert.match(results[0].output, /en\.wikipedia\.org/);
    assert.strictEqual(results[0].duration_ms, 2000, 'the step keeps the time between its call and result');
    assert.strictEqual(done.length, 1);
    assert.strictEqual(done[0].duration_ms, 9000, 'the run time is the first and last event');
    assert.strictEqual(done[0].ok, true);
    assert.ok(!out.some((l) => l.t === 'state'), 'a finished page does not replay states over its final one');
}

// A call a finished task never answered: done with "No result", never a spinner.
{
    const out = lines([call('Eiffel Tower height', '02'), end('failed', '30')], { final: true, state: 'failed' });
    const results = out.filter((l) => l.t === 'tool_result');
    assert.strictEqual(results.length, 1, 'an unanswered call settles when the task has ended');
    assert.strictEqual(results[0].ok, true);
    assert.match(results[0].output, /No result was recorded/);
    assert.strictEqual(out.filter((l) => l.t === 'done')[0].ok, false, 'a failed task says so on its done line');
}

// While the task runs the same call is still running: no invented result, no done line, states replay.
{
    const out = lines([{ kind: 'state', state: 'running', at: at('00') }, call('Eiffel Tower height', '02')], { final: false });
    assert.strictEqual(out.filter((l) => l.t === 'tool_result').length, 0);
    assert.strictEqual(out.filter((l) => l.t === 'done').length, 0);
    assert.deepStrictEqual(out.filter((l) => l.t === 'state').map((l) => l.state), ['running']);
}

// Identical calls separated by what the agent said are two tries, not one.
{
    const out = lines([call('same', '02'), result('one', '03'), text('Let me check again.', '04'), call('same', '05'), result('two', '06')], { final: true, state: 'succeeded' });
    assert.strictEqual(out.filter((l) => l.t === 'tool').length, 2);
    assert.strictEqual(out.filter((l) => l.t === 'tool_result').length, 2);
}

// A different tool or input is a different line; a result with no call is dropped.
{
    const out = lines([
        call('a', '02'), { kind: 'output', step: 'tool_call', tool: 'run_tool', input: 'mx', at: at('03') },
        { kind: 'output', step: 'tool_result', tool: 'run_tool', text: 'ok', at: at('05') },
        { kind: 'output', step: 'tool_result', tool: 'ghost', text: 'orphan', at: at('06') },
    ], { final: false });
    assert.deepStrictEqual(out.filter((l) => l.t === 'tool').map((l) => l.name), ['web_search', 'run_tool']);
    assert.strictEqual(out.filter((l) => l.t === 'tool_result').length, 1, 'only the call that exists gets a result');
}

// Time helpers: first event and the span; 0 rather than a made-up clock when the events carry no time.
{
    assert.strictEqual(firstAt([{ at: at('03') }, { at: at('01') }]), Date.parse(at('03')));
    assert.strictEqual(firstAt([]), 0);
    assert.strictEqual(duration([{ at: at('01') }, { at: at('11') }]), 10000);
    assert.strictEqual(duration([{ at: at('01') }]), 0);
    assert.strictEqual(duration([], { durationMs: 2500 }), 2500);
}

console.log('task events: all checks passed');
