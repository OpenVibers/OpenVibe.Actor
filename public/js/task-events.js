/* Actor's task events (actor.task-event@1) as openvibe-shared/agent-session.js lines (1.1), for js/task.js.
 *
 * The shared view pairs a result with its call only by tool name, and times a step from when the page received it; on a
 * finished task that left a search running forever and the run's time reading "0 s". So the page says what the events
 * say instead:
 *   - every call gets an id, and its result (with the time between them, where both carry one) lands on it;
 *   - identical consecutive calls (same tool, same input) fold into one line with a count ("×2");
 *   - a task that has ended settles any call it never answered as done, with "No result was recorded for this step."
 *   - the run's real time is the task's own: first event → last event, on the done line.
 * Pure (no DOM), so test/task-events.test.js can prove each rule.
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
     * events → lines. opts.final says the task has ended (settle unanswered calls, add the done line with the run's
     * time); opts.state is its final state (the done line is ok only when "succeeded"); opts.durationMs overrides the
     * computed time.
     */
    function lines(events, opts) {
        opts = opts || {};
        var out = [];
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
            if (e.step === 'plan') { out.push(withAgent({ t: 'step', text: text }, e)); continue; }
            if (e.step === 'handoff') { out.push(withAgent({ t: 'handoff', from: null, to: e.agent || null, reason: text }, e)); continue; }
            if (e.step === 'check') { out.push(withAgent({ t: 'note', level: /^checked/i.test(text) ? 'info' : 'warning', text: text }, e)); continue; }
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

    return { lines: lines, firstAt: firstAt, duration: duration };
});
