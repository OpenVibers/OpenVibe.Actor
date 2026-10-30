/* Actor's task events (actor.task-event@1) as openvibe-shared/agent-session.js lines (1.1), for js/task.js.
 *
 * The shared view pairs a result with its call only by tool name, and times a step from when the page received it; on a
 * finished task that left a search running forever and the run's time reading "0 s". So the page says what the events
 * say instead:
 *   - every call gets an id, and its result (with the time between them, where both carry one) lands on it;
 *   - identical consecutive calls (same tool, same input) fold into one line with a count ("×2");
 *   - a task that has ended settles any call it never answered as done, with "No result was recorded for this step."
 *   - the run's real time is the task's own: first event → last event, on the done line;
 *   - a plan the loop states becomes one divider naming the step in hand ("Step 2 of 4 · Read the pages"), so the
 *     calls under it read as that step's (Actor v2, stage V2-5); plan(text) reads the plan back for the plan card.
 * Pure (no DOM), so test/task-events.test.js can prove each rule. The server requires it too (server/http/pages.js).
 */
(function (root, factory) {
    'use strict';
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.OpenVibeTaskEvents = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    var MAX_TEXT = 6000;
    var MAX_INPUT = 300;

    function cut(value, n) { var s = String(value == null ? '' : value); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
    function at(event) { var t = Date.parse(event && event.at); return Number.isFinite(t) ? t : null; }
    function inputOf(value) {
        if (typeof value === 'string') return cut(value, MAX_INPUT);
        if (value == null) return '';
        try { return cut(JSON.stringify(value), MAX_INPUT); } catch (err) { return cut(String(value), MAX_INPUT); }
    }
    function withAgent(line, event) { if (event.agent) line.agent = String(event.agent); return line; }

    /** The instant the task's run started, from its first event (0 when it has none). */
    function firstAt(events) {
        for (var i = 0; i < (events || []).length; i++) { var t = at(events[i]); if (t != null) return t; }
        return 0;
    }

    /** The run's real time: the first and last event, or opts.durationMs when the caller knows it. */
    function duration(events, opts) {
        if (opts && opts.durationMs != null) return Math.max(0, Number(opts.durationMs) || 0);
        var first = null, last = null;
        for (var i = 0; i < (events || []).length; i++) {
            var t = at(events[i]);
            if (t == null) continue;
            if (first == null || t < first) first = t;
            if (last == null || t > last) last = t;
        }
        return first == null || last == null ? 0 : Math.max(0, last - first);
    }

    /**
     * The artifacts a tool made, as the attachments the shared session draws (openvibe-shared 4.50.0). Actor's task
     * events are a public contract (actor.task-event@2, additionalProperties false), so the mapping happens here,
     * on the page, and not on the event the service sends.
     */
    function attachments(artifacts) {
        var out = [];
        for (var i = 0; i < (artifacts || []).length; i++) {
            var a = artifacts[i];
            if (!a || typeof a !== 'object') continue;
            var url = String(a.url || '').trim();
            if (!url) continue;
            out.push({ url: url, name: String(a.name || ''), mime: String(a.mime || ''), size: Number(a.size) || 0, kind: String(a.kind || 'file'), role: 'output' });
        }
        return out.length ? out : undefined;
    }

    /**
     * events → lines. opts.final says the task has ended (settle unanswered calls, add the done line with the run's
     * time); opts.state is its final state (the done line is ok only when "succeeded"); opts.durationMs overrides the
     * computed time.
     */
    // A plan as the loop states it (server/runtime/loop.js planText): an optional "Assumptions: a; b" line, then one line
    // a step, "\u2713 1. goal" (done), "\u2192 2. goal" (in hand) or "\u00b7 3. goal" (next). → { assumptions, steps } or null.
    var PLAN_LINE = /^([\u2713\u2192\u00b7]) (\d+)\. (.+)$/;
    function plan(text) {
        var out = { assumptions: [], steps: [] };
        String(text || '').split('\n').forEach(function (raw) {
            var line = raw.trim(), m = PLAN_LINE.exec(line);
            if (m) out.steps.push({ goal: m[3], state: m[1] === '\u2713' ? 'done' : m[1] === '\u2192' ? 'active' : 'todo' });
            else if (/^Assumptions: /.test(line)) out.assumptions = line.slice(13).split('; ').filter(Boolean);
            // The brain's ledgers (stage V2-8) ride in the plan event: "Task ledger: given … · find … · derive …" and
            // "Progress: done/not done; looping/not looping; moving/no progress; next …". Parsed here so both the
            // server-rendered plan card and the live one show them.
            else if (/^Task ledger: /.test(line)) {
                var ledger = { given: [], lookup: [], derive: [] };
                line.slice(13).split(' \u00b7 ').forEach(function (part) {
                    if (/^given /.test(part)) ledger.given = part.slice(6).split('; ').filter(Boolean);
                    else if (/^find /.test(part)) ledger.lookup = part.slice(5).split('; ').filter(Boolean);
                    else if (/^derive /.test(part)) ledger.derive = part.slice(7).split('; ').filter(Boolean);
                });
                out.ledger = ledger;
            } else if (/^Progress: /.test(line)) {
                // "Progress: done; not looping; moving; stuck no; next none" (stage V2-8). Parsed token by token so an
                // older event with only done/looping/moving/next still reads.
                var progress = { done: false, looping: false, progressing: true, stuck: false, next: null, stopped: null };
                line.slice(10).split('; ').forEach(function (bit) {
                    if (bit === 'done') progress.done = true;
                    else if (bit === 'not done') progress.done = false;
                    else if (bit === 'looping') progress.looping = true;
                    else if (bit === 'not looping') progress.looping = false;
                    else if (bit === 'moving') progress.progressing = true;
                    else if (bit === 'no progress') progress.progressing = false;
                    else if (/^stuck /.test(bit)) progress.stuck = bit.slice(6) === 'yes';
                    else if (/^next /.test(bit)) progress.next = bit.slice(5) === 'none' ? null : bit.slice(5);
                    else if (/^stopped /.test(bit)) progress.stopped = bit.slice(8) || null;
                });
                out.progress = progress;
            }
        });
        return out.steps.length || out.ledger ? out : null;
    }
    /** The divider a plan draws in the session: the step in hand, or the whole plan done. */
    function planLine(p) {
        if (!p || !p.steps.length) return null;
        var at = -1;
        p.steps.forEach(function (st, k) { if (at < 0 && st.state === 'active') at = k; });
        if (at >= 0) return 'Step ' + (at + 1) + ' of ' + p.steps.length + ' \u00b7 ' + p.steps[at].goal;
        var done = p.steps.every(function (st) { return st.state === 'done'; });
        return done ? 'Every step of the plan is done' : 'A plan of ' + p.steps.length + ' steps';
    }

    function lines(events, opts) {
        opts = opts || {};
        var out = [];
        var lastPlan = null;  // the last plan divider, so a plan restated with the same step in hand draws nothing
        var open = {};      // tool name → calls of that tool still waiting for their result
        var last = null;    // the last call, for folding an identical next one
        var folded = null;  // the result of a folded call, which must not become a step of its own
        var n = 0;

        function settle(call, tool) {
            out.push({ t: 'tool_result', id: call.id, name: tool, ok: true, output: 'No result was recorded for this step.' });
        }

        for (var i = 0; i < (events || []).length; i++) {
            var e = events[i];
            if (!e || typeof e !== 'object') continue;
            if (e.kind === 'state' || e.kind === 'end') {
                if (!opts.final && e.state) out.push({ t: 'state', state: String(e.state) });
                continue;
            }
            if (e.kind !== 'output') continue;
            var text = cut(e.text, MAX_TEXT);

            if (e.step === 'tool_call') {
                var tool = String(e.tool || 'tool');
                var input = inputOf(e.input);
                folded = null;   // a new call closes the one a duplicate expected to fold into
                if (last && last.tool === tool && last.input === input) {
                    last.n++;
                    var label = input ? input + ' ×' + last.n : '×' + last.n;
                    last.line.what = label;
                    last.line.input = { description: label };
                    folded = { tool: tool };
                    continue;
                }
                var call = withAgent({ t: 'tool', id: 't' + (++n), name: tool, what: input, input: { description: input } }, e);
                out.push(call);
                last = { tool: tool, input: input, line: call, n: 1, at: at(e) };
                (open[tool] = open[tool] || []).push({ id: call.id, at: last.at });
                continue;
            }

            if (e.step === 'tool_result') {
                var resultTool = String(e.tool || 'tool');
                if (folded && folded.tool === resultTool) { folded = null; continue; }
                folded = null;
                var queue = open[resultTool];
                var waiting = queue && queue.length ? queue.shift() : null;
                if (!waiting) continue;   // a result without its call (a page cut short) is not a step
                var line = withAgent({ t: 'tool_result', id: waiting.id, name: resultTool, ok: !e.is_error, output: cut(e.text, 8000) }, e);
                var atts = attachments(e.artifacts);
                if (atts) line.attachments = atts;
                var seen = at(e);
                if (seen != null && waiting.at != null && seen > waiting.at) line.duration_ms = seen - waiting.at;
                out.push(line);
                continue;
            }

            // Anything the agent said between two calls ends the "same call twice" run: a repeat after an answer is a
            // real second try. A result does not: the pairs of a repeated search are call, result, call, result.
            last = null;
            if (e.step === 'text') {
                out.push(withAgent(e.is_error ? { t: 'note', level: 'error', text: text } : { t: 'text', text: text }, e));
                continue;
            }
            if (e.step === 'resume') { out.push(withAgent({ t: 'note', level: 'info', text: 'Resumed: ' + text }, e)); continue; }
            if (e.step === 'fork') { out.push(withAgent({ t: 'note', level: 'info', text: text }, e)); continue; }
            if (e.step === 'plan') {
                var stated = plan(text), divider = stated ? planLine(stated) : text;
                if (divider && divider !== lastPlan) out.push(withAgent({ t: 'step', text: divider }, e));
                lastPlan = divider;
                continue;
            }
            if (e.step === 'handoff') { out.push(withAgent({ t: 'handoff', from: null, to: e.agent || null, reason: text }, e)); continue; }
            if (e.step === 'check') { out.push(withAgent({ t: 'note', level: /^checked/i.test(text) ? 'info' : 'warning', text: text }, e)); continue; }
            if (e.step === 'escalation') { out.push(withAgent({ t: 'note', level: 'info', text: 'Escalated: ' + text }, e)); continue; }
            if (text) out.push(withAgent({ t: 'text', text: text }, e));
        }

        if (opts.final) {
            for (var name in open) {
                if (!Object.prototype.hasOwnProperty.call(open, name)) continue;
                open[name].forEach(function (call) { settle(call, name); });
            }
            var ms = duration(events, opts);
            if (ms > 0) out.push({ t: 'done', ok: opts.state ? String(opts.state) === 'succeeded' : true, duration_ms: ms, cost_usd: 0 });
        }
        return out;
    }

    // "Assuming The price…" reads as a sentence that started after a full stop. The first letter of an assumption
    // is lowered unless it is an acronym (USD, EU), a camel-cased name (OpenAI, ChatGPT) or a known proper noun
    // (a day, month, city or product). Several assumptions become one sentence each (stage V2-8 review).
    var PROPER = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December|Lisbon|Porto|Madrid|Barcelona|London|Paris|Berlin|Rome|Tokyo|New York|Portugal|Spain|Europe|OpenVibe|Actor|Network|ChatGPT|Google|Microsoft|Apple|Amazon|Netflix)$/;
    function lowerFirst(text) {
        var s = String(text == null ? '' : text).trim();
        var m = /^([A-Za-z][A-Za-z'\u2019.-]*)/.exec(s);
        if (!m) return s;
        var word = m[1];
        if (word === 'I') return s;
        if (/^[A-Z]{2,}/.test(word)) return s;          // an acronym
        if (/[a-z][A-Z]/.test(word)) return s;          // OpenAI, ChatGPT
        if (PROPER.test(word)) return s;                // a known proper noun
        return word.charAt(0).toLowerCase() + s.slice(1);
    }
    function assumingLine(assumptions) {
        var list = (assumptions || []).map(function (a) { return String(a == null ? '' : a).trim(); }).filter(Boolean);
        if (!list.length) return '';
        var out = 'Assuming ' + lowerFirst(list[0]);
        for (var i = 1; i < list.length; i++) out += '. ' + list[i].replace(/[.?!]+$/, '');
        return out.replace(/[.?!]*$/, '') + '.';
    }

    return { lines: lines, firstAt: firstAt, duration: duration, attachments: attachments, plan: plan, planLine: planLine, assumingLine: assumingLine, lowerFirst: lowerFirst };
});
