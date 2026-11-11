'use strict';
/**
 * Time to first word, before and after (one-engine slice).
 *
 * Before: the product asked OpenVibe.AI directly for one answer (a chat.member.turn) and rendered the answer.
 * After:  the product asks Actor for one turn, and Actor answers it (the same model behind its own loop).
 *
 * This measures both on the same machine, against the same stand-in provider, so the numbers compare:
 *   - the old path: one model round trip (the provider's own latency),
 *   - the new path: Actor's task from the moment the product asks, until the answer's first words arrive in the
 *     task's live event stream (the moment a product would render them).
 *
 * Run: node test/bench-first-word.js
 */
const { boot } = require('./helpers/boot');

/** The stand-in provider's own latency per call, so both paths pay the same price per model call. */
const MODEL_LATENCY_MS = Number(process.env.BENCH_MODEL_LATENCY_MS || 120);

/** The old path: one direct model call, the way the products answered before. */
async function oldPath() {
    const started = Date.now();
    await new Promise((r) => setTimeout(r, MODEL_LATENCY_MS));
    return Date.now() - started;
}

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const saved = t.config.loop.selfReflections;
    t.config.loop.selfReflections = 0;      // the cheapest run: no reflection pass
    t.providers.reset();
    t.providers.state.script = Array.from({ length: 60 }, () => ({ content: 'A quiet weekend: the night train south, one good book, no plans before noon.' }));

    /** The new path: an Actor turn, measured from the product's ask to the first words in the event stream. */
    const newPath = async (label) => {
        const started = Date.now();
        const r = await t.get('/api/v1/tasks', {
            as: kim, method: 'POST', json: {
                task: 'Companion Sable: "Help me plan a quiet weekend."',
                mode: 'cheapest', budget: { per_task_usd: 0.05 },
                conversation: { product: 'exchange', id: `bench-${label}` }, tools: [],
            }, headers: { 'sec-fetch-site': 'same-origin' },
        });
        if (r.status !== 201) throw new Error(`the task was refused: ${r.status} ${r.text}`);
        const id = r.json().id;
        // The live stream: the first text step is the answer's first words.
        let firstWord = null;
        const res = await fetch(`${t.base}/api/v1/tasks/${id}/events`, { headers: { cookie: t.signIn(kim), accept: 'text/event-stream' } });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
                const chunk = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                for (const line of chunk.split('\n')) {
                    if (!line.startsWith('data:')) continue;
                    let e = null;
                    try { e = JSON.parse(line.slice(5).trim()); } catch { continue; }
                    if (e && e.step === 'text' && String(e.text || '').trim() && firstWord == null) firstWord = Date.now() - started;
                }
            }
            if (firstWord != null) { try { await reader.cancel(); } catch { /* */ } break; }
        }
        return { firstWord: firstWord == null ? Date.now() - started : firstWord };
    };

    const oldMs = await oldPath();
    const runs = [];
    for (let i = 0; i < 5; i++) runs.push(await newPath(`r${i}`));
    t.config.loop.selfReflections = saved;

    const avg = (a) => Math.round(a.reduce((s, x) => s + x, 0) / a.length);
    // The boot captures console.log, so the numbers go to stderr.
    process.stderr.write(JSON.stringify({
        modelLatencyMs: MODEL_LATENCY_MS,
        before: { directAiCallMs: oldMs },
        after: { firstWordMs: avg(runs.map((r) => r.firstWord)), firstWordRuns: runs.map((r) => r.firstWord) },
    }, null, 2) + '\n');

    await t.close();
})().catch((e) => { console.error(e); process.exit(1); });
