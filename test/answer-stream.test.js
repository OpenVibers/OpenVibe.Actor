'use strict';
/**
 * The answer as it is written (plan L55 C2): a model call with onDelta streams (stream: true), passes each piece of
 * its text on as it arrives, and returns what the whole answer would have been; the task stream sends the pieces to the
 * readers that asked (?deltas=1) as `delta` events with no id, gathered, never stored, flushed before a stored event.
 *
 *   node test/answer-stream.test.js
 */
const assert = require('assert');
const { EventEmitter } = require('events');
const { chatClient, readStream, ProviderError } = require('../server/agents/providers');
const { createTaskStream } = require('../server/tasks/stream');

const sse = (chunks) => chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('');
function streamed(text, { split = 7, status = 200 } = {}) {
    // Sent in small byte pieces, so a line is often cut in two: the reader must put lines back together.
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream({
        start(ctl) { for (let i = 0; i < bytes.length; i += split) ctl.enqueue(bytes.slice(i, i + split)); ctl.close(); },
    });
    return new Response(body, { status, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}
const chunk = (delta, extra = {}) => ({ id: 'c1', object: 'chat.completion.chunk', model: 'deepseek-chat', choices: [{ index: 0, delta, finish_reason: null }], ...extra });

(async () => {
    // 1. Text, reasoning, tool calls joined by index, finish, usage and AI's x_openvibe, from pieces cut mid-line.
    {
        const pieces = [];
        const body = sse([
            chunk({ role: 'assistant', content: '' }),
            chunk({ reasoning_content: 'Think ' }),
            chunk({ reasoning_content: 'first.' }),
            chunk({ content: 'Hello' }),
            chunk({ content: ', **world**' }),
            chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'web_', arguments: '{"q":' } }] }),
            chunk({ tool_calls: [{ index: 0, function: { name: 'search', arguments: '"cats"}' } }] }),
            chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'read_page', arguments: '{}' } }] }),
            { id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
            { id: 'c1', choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_cache_hit_tokens: 100 } },
            { id: 'c1', choices: [], x_openvibe: { cost_usd: 0.0012 } },
            '[DONE]',
        ]);
        const j = await readStream(streamed(body), (t) => pieces.push(t));
        assert.deepStrictEqual(pieces, ['Hello', ', **world**'], 'only the answer text goes to onDelta, piece by piece');
        const m = j.choices[0].message;
        assert.strictEqual(m.content, 'Hello, **world**');
        assert.strictEqual(m.reasoning_content, 'Think first.', 'the reasoning is kept on the message (DeepSeek wants it back)');
        assert.deepStrictEqual(m.tool_calls, [
            { id: 'call_a', type: 'function', function: { name: 'web_search', arguments: '{"q":"cats"}' } },
            { id: 'call_b', type: 'function', function: { name: 'read_page', arguments: '{}' } },
        ]);
        assert.strictEqual(j.choices[0].finish_reason, 'tool_calls');
        assert.strictEqual(j.model, 'deepseek-chat');
        assert.strictEqual(j.usage.prompt_tokens, 120);
        assert.strictEqual(j.x_openvibe.cost_usd, 0.0012);
    }

    // 2. A provider that repeats the whole tool name on every piece is not doubled; an empty answer with tool calls
    //    has content null, as the whole answer would.
    {
        const body = sse([
            chunk({ tool_calls: [{ index: 0, id: 'x', function: { name: 'fetch_url', arguments: '{"u"' } }] }),
            chunk({ tool_calls: [{ index: 0, function: { name: 'fetch_url', arguments: ':1}' } }] }),
            '[DONE]',
        ]);
        const j = await readStream(streamed(body), () => {});
        assert.strictEqual(j.choices[0].message.tool_calls[0].function.name, 'fetch_url');
        assert.strictEqual(j.choices[0].message.tool_calls[0].function.arguments, '{"u":1}');
        assert.strictEqual(j.choices[0].message.content, null);
    }

    // 3. A failure the stream carries is a ProviderError; a listener that throws does not break the call.
    {
        const body = sse([chunk({ content: 'Par' }), { error: { message: 'upstream went away', code: 'provider.error' } }, '[DONE]']);
        await assert.rejects(readStream(streamed(body), () => { throw new Error('listener'); }), (err) => err instanceof ProviderError && /upstream went away/.test(err.message));
    }

    // 4. An upstream that answers JSON (it cannot stream) is read whole, and its text reaches onDelta once.
    {
        const pieces = [];
        const res = new Response(JSON.stringify({ model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'Whole.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
        const j = await readStream(res, (t) => pieces.push(t));
        assert.strictEqual(j.choices[0].message.content, 'Whole.');
        assert.deepStrictEqual(pieces, ['Whole.']);
    }

    // 5. chatClient: with onDelta the request streams and asks for usage; the result has the usual shape and price.
    //    Without it, nothing changes: one JSON answer.
    {
        const sent = [];
        const fetchImpl = async (url, init) => {
            const body = JSON.parse(init.body);
            sent.push({ url, body, accept: init.headers.accept || null });
            if (body.stream) return streamed(sse([chunk({ content: 'Two ' }), chunk({ content: 'words.' }), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 1000000, completion_tokens: 1000000, prompt_cache_hit_tokens: 0 } }, '[DONE]']));
            return new Response(JSON.stringify({ model: 'deepseek-chat', choices: [{ index: 0, message: { role: 'assistant', content: 'Two words.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000000, completion_tokens: 1000000 } }), { headers: { 'content-type': 'application/json' } });
        };
        const chat = chatClient({ baseUrl: 'https://api.example', apiKey: 'k', model: 'deepseek-chat', rates: { input_usd_per_mtok: 0.25, output_usd_per_mtok: 1 }, fetchImpl });
        const pieces = [];
        const a = await chat({ messages: [{ role: 'user', content: 'hi' }], onDelta: (t) => pieces.push(t) });
        const b = await chat({ messages: [{ role: 'user', content: 'hi' }] });
        assert.strictEqual(sent[0].body.stream, true);
        assert.deepStrictEqual(sent[0].body.stream_options, { include_usage: true });
        assert.strictEqual(sent[0].accept, 'text/event-stream');
        assert.ok(!('stream' in sent[1].body), 'no onDelta: no stream');
        assert.deepStrictEqual(pieces, ['Two ', 'words.']);
        for (const r of [a, b]) {
            assert.strictEqual(r.text, 'Two words.');
            assert.deepStrictEqual(r.toolCalls, []);
            assert.strictEqual(r.finish, 'stop');
            assert.strictEqual(r.cost_usd, 1.25, 'priced the same way streamed or not');
        }
    }

    // 6. A refused streamed call is the same ProviderError as a refused whole one.
    {
        const fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'Too many requests' } }), { status: 429, headers: { 'content-type': 'application/json' } });
        const chat = chatClient({ baseUrl: 'https://api.example', apiKey: 'k', model: 'm', rates: {}, fetchImpl });
        await assert.rejects(chat({ messages: [], onDelta: () => {} }), (err) => err.code === 'actor.provider.rate_limited' && err.status === 429);
    }

    // 7. The task stream: deltas go only to a reader that asked, gathered, with no id line; a stored event flushes the
    //    gathered text first; a new call number flushes the old call's text; the end drops what is left.
    {
        const stream = createTaskStream({ log: { warn() {} } });
        const fakeRes = () => ({ chunks: [], ended: false, status() { return this; }, set() { return this; }, flushHeaders() {}, write(c) { this.chunks.push(c); }, end() { this.ended = true; } });
        const asked = fakeRes(), plain = fakeRes();
        await stream.serve(new EventEmitter(), asked, { taskId: 'tsk_d', after: 0, deltas: true, readBacklog: async () => [], isEnded: async () => false });
        await stream.serve(new EventEmitter(), plain, { taskId: 'tsk_d', after: 0, readBacklog: async () => [], isEnded: async () => false });
        assert.strictEqual(stream.wants('tsk_d'), true, 'a reader asked: the loop streams');
        assert.strictEqual(stream.wants('tsk_x'), false, 'nobody asked: the loop calls the model as before');
        stream.delta('tsk_d', { text: 'Hel', n: 1 });
        stream.delta('tsk_d', { text: 'lo', n: 1 });
        stream.delta('tsk_d', { text: 'Next', n: 2 });   // a new call: call 1's text goes out first
        stream.publish('tsk_d', { task_id: 'tsk_d', seq: 1, kind: 'output', step: 'text', text: 'Hello' });
        const events = (res) => res.chunks.join('').split('\n\n').filter((b) => /^(id|event):/m.test(b));
        const got = events(asked);
        assert.deepStrictEqual(got, [
            'event: delta\ndata: {"text":"Hello","n":1}',
            'event: delta\ndata: {"text":"Next","n":2}',
            'id: 1\nevent: output\ndata: {"task_id":"tsk_d","seq":1,"kind":"output","step":"text","text":"Hello"}',
        ]);
        assert.deepStrictEqual(events(plain), [got[2]], 'a reader that did not ask gets only the stored events');
        stream.delta('tsk_d', { text: 'left over', n: 3 });
        stream.end('tsk_d');
        await new Promise((r) => setTimeout(r, 100));
        assert.ok(!asked.chunks.join('').includes('left over'), 'nothing is sent after the end');
        // The timer sends gathered text on its own when no stored event comes.
        const late = fakeRes();
        await stream.serve(new EventEmitter(), late, { taskId: 'tsk_e', after: 0, deltas: true, readBacklog: async () => [], isEnded: async () => false });
        stream.delta('tsk_e', { text: 'Soon', n: 1 });
        await new Promise((r) => setTimeout(r, 120));
        assert.deepStrictEqual(events(late), ['event: delta\ndata: {"text":"Soon","n":1}']);
        // Nobody asked: nothing is gathered.
        stream.delta('tsk_none', { text: 'x', n: 1 });
        stream.end('tsk_e');
    }

    console.log('answer stream: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
