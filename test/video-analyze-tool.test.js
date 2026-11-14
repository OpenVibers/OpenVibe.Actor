'use strict';
/**
 * video_analyze (plan §Z.9): the agent watches a video the person may read through OpenVibe.AI's video.analyze.
 *
 * - it asks AI with Actor's own service token (audience openvibe.ai), the person as on_behalf_of, the depth and the ask;
 * - it follows the analysis until it ends and answers in words: the summary, the answer, the chapters with times, the
 *   names with whether they were shown or said, the transcript's start;
 * - the keyframes keep their captions and lose their addresses (they are the requester's own, private);
 * - only a video on OpenVibe (med_, att_, an openvibe.media link); a signed-in person only; a failed analysis says why;
 * - it reads (acts false), needs the person's files to be readable, and is on the openvibe connector.
 */
const assert = require('assert');
const { createRegistry } = require('../server/runtime/tools');

const ME = 'usr_01M4W5JBFEG3QG9ER8W1A2K0RX';
const MED = 'med_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const config = { networkInternalUrl: 'http://network.test', oauth: { clientId: 'actor', clientSecret: 'actor-secret' }, ai: { url: 'http://ai.test' }, services: {} };
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

function fakeAi({ fail = false } = {}) {
    const calls = [];
    let polls = 0;
    const fetchImpl = async (url, opts = {}) => {
        const u = new URL(url);
        const call = { method: opts.method || 'GET', path: u.pathname, auth: (opts.headers || {}).Authorization || (opts.headers || {}).authorization || null, body: (() => { try { return opts.body ? JSON.parse(opts.body) : null; } catch { return String(opts.body); } })() };
        calls.push(call);
        if (u.pathname === '/oauth/token') return json({ access_token: 'svc-ai-token', token_type: 'Bearer', expires_in: 300 });
        if (u.pathname === '/api/v1/video-analyses' && call.method === 'POST') return json({ video_analysis: { id: 'run_va1', status: 'queued' }, price_usd: 0.05, held_usd: 0.05 }, 202);
        if (u.pathname === '/api/v1/video-analyses/run_va1/state') {
            polls += 1;
            if (polls < 2) return json({ video_analysis: { id: 'run_va1', status: 'running', step: 'describe', progress: 0.5 } });
            return json({ video_analysis: fail ? { id: 'run_va1', status: 'failed', error: { detail: 'media.unreadable: the file could not be read' } } : { id: 'run_va1', status: 'succeeded' } });
        }
        if (u.pathname === '/api/v1/video-analyses/run_va1') {
            return json({ video_analysis: { id: 'run_va1', status: 'succeeded', report: {
                media_id: MED, duration_s: 94.5,
                keyframes: [{ t: 0, url: '/api/v1/video-analyses/run_va1/frames/0', caption: 'A desk with a laptop.', text: 'README.md' }],
                transcript: { lang: 'en', words: [], text: 'we open the readme' },
                chapters: [{ start: 0, end: 48, title: 'The README' }, { start: 48, end: 94.5, title: 'The tests' }],
                summary: 'A developer opens a README and runs the tests.',
                entities: [{ name: 'README.md', kind: 'object', evidence: [{ t: 0, from: 'frame' }] }],
                tags: ['screen recording'], answer: 'It shows the tests passing.',
                explicit: { category: 'fine' }, receipt: { cost_usd: 0.0033 },
            } } });
        }
        return json({ detail: 'no such route' }, 404);
    };
    return { fetchImpl, calls };
}

const ctxFor = (fetchImpl, requester = 'user:' + ME) => ({ config, fetch: fetchImpl, requester, taskId: 'tsk_01M4W5JBFEG3QG9ER8W1A2K0RZ', videoPollMs: 5, log: console });

(async () => {
    const reg = createRegistry({ strict: true, log: { warn() {}, log() {} } });
    const tool = reg.get('video_analyze');
    assert.ok(tool, 'the tool is in the registry');
    assert.strictEqual(tool.acts, undefined, 'it reads, so it does not act');
    assert.deepStrictEqual(tool.needs, { files: 'read', network: false });
    assert.strictEqual(tool.connector, 'openvibe');

    // A whole analysis.
    const ai = fakeAi();
    const out = await reg.run('video_analyze', { video: MED, ask: 'Do the tests pass?', depth: 'standard', duration_s: 94 }, ctxFor(ai.fetchImpl));
    assert.ok(!out.isError, out.text);
    const post = ai.calls.find((c) => c.path === '/api/v1/video-analyses' && c.method === 'POST');
    assert.strictEqual(post.auth, 'Bearer svc-ai-token', "Actor's own service token");
    assert.deepStrictEqual(post.body.on_behalf_of, { type: 'user', id: ME }, 'the person rides as on_behalf_of');
    assert.strictEqual(post.body.media_id, MED);
    assert.strictEqual(post.body.depth, 'standard');
    assert.strictEqual(post.body.ask, 'Do the tests pass?');
    assert.strictEqual(post.body.duration_s, 94);
    assert.ok(post.body.idempotency_key.startsWith('actor:tsk_'), 'a retried step does not start a second analysis');
    const token = ai.calls.find((c) => c.path === '/oauth/token');
    assert.ok(token, 'a service token was asked for');
    assert.ok(ai.calls.filter((c) => c.path.endsWith('/state')).length >= 2, 'it followed the state');
    assert.match(out.text, /Summary: A developer opens a README/);
    assert.match(out.text, /Answer: It shows the tests passing\./);
    assert.match(out.text, /- 0:00–0:48 The README/);
    assert.match(out.text, /README\.md \[object\] \(shown at 0:00\)/);
    assert.match(out.text, /Transcript \(start\): we open the readme/);
    assert.deepStrictEqual(out.data.keyframes, [{ t: 0, caption: 'A desk with a laptop.', text: 'README.md' }], 'captions kept, addresses dropped');
    assert.ok(!JSON.stringify(out.data).includes('/frames/'), 'no frame address leaves');

    // An attachment and a Media link are videos too; anything else is refused before AI is asked.
    for (const [video, field] of [['att_01JZ0M0Q8F3K2V7YB6N4T5R9WQ', 'attachment_id'], ['https://openvibe.media/a/att_01JZ0M0Q8F3K2V7YB6N4T5R9WQ/7224.mp4', 'url']]) {
        const a = fakeAi();
        const r = await reg.run('video_analyze', { video }, ctxFor(a.fetchImpl));
        assert.ok(!r.isError, r.text);
        assert.strictEqual(a.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/video-analyses').body[field], video);
        assert.strictEqual(a.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/video-analyses').body.depth, 'quick', 'quick by default');
    }
    const elsewhere = fakeAi();
    const refused = await reg.run('video_analyze', { video: 'https://example.com/a.mp4' }, ctxFor(elsewhere.fetchImpl));
    assert.ok(refused.isError);
    assert.match(refused.text, /Media id/);
    assert.strictEqual(elsewhere.calls.length, 0, 'nothing was asked');

    // No person, no video.
    const nobody = await reg.run('video_analyze', { video: MED }, ctxFor(fakeAi().fetchImpl, 'app:app_x'));
    assert.ok(nobody.isError);

    // A failed analysis says why.
    const bad = fakeAi({ fail: true });
    const failed = await reg.run('video_analyze', { video: MED }, ctxFor(bad.fetchImpl));
    assert.ok(failed.isError);
    assert.match(failed.text, /could not be watched: media\.unreadable/);

    console.log('video-analyze-tool: an agent watches a video for the person, in words, with its frames kept private');
})().catch((e) => { console.error(e); process.exit(1); });
