'use strict';

// A durable AG-UI projection. State is JSON so a restart resumes tool identities and groups exactly.
const oneLine = (s, n = 180) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
function target(input) {
    if (typeof input === 'string') { try { return target(JSON.parse(input)); } catch { return input; } }
    const i = input || {};
    return i.file_path || i.path || i.url || i.query || i.pattern || i.command || i.cmd || i.target || i.description || '';
}
function titleFor(name, input) {
    if (name === 'run_tool' && input && typeof input === 'object') return titleFor(input.tool, input.input);
    const tool = String(name || '').toLowerCase().replace(/[-.]/g, '_');
    const t = oneLine(target(input));
    const label = (kind, verb) => ({ kind, title: oneLine(`${verb}${t ? ` ${t}` : ''}`, 160) });
    if (/web.?search|search_web/.test(tool)) return label('search', 'Searched the web for');
    if (/fetch|browse_url|open_url/.test(tool)) {
        let host = t; try { host = new URL(t).hostname; } catch { /* plain target */ }
        return { kind: 'fetch', title: `Fetched${host ? ` ${host}` : ' a page'}` };
    }
    if (/^(read|read_file|list_dir|ls)$|file_read/.test(tool)) return label('read', 'Read');
    if (/grep|glob|search|find_tools/.test(tool)) return label('search', 'Searched for');
    if (/write|edit|patch|delete/.test(tool)) return label('edit', 'Edited');
    if (/bash|shell|exec|run_command|terminal/.test(tool)) return label('run', 'Ran');
    if (/todo|plan/.test(tool)) return { kind: 'plan', title: 'Updated the plan' };
    if (/browser|computer|screenshot/.test(tool)) return label('browse', 'Used the browser for');
    if (/ask|question|approval/.test(tool)) return label('ask', 'Asked about');
    if (/agent|task|delegate/.test(tool)) return label('agent', 'Asked an agent to work on');
    return null;
}
function sourcesIn(value) {
    const found = new Map();
    const add = (url, title) => {
        try {
            const u = new URL(String(url).replace(/[),.;]+$/, ''));
            if (u.protocol !== 'https:' || u.username || u.password) return;
            if ([...u.searchParams.keys()].some((k) => /token|key|signature|secret|auth/i.test(k))) return;
            u.hash = '';
            found.set(u.href, { url: u.href, title: oneLine(title || u.hostname), site: u.hostname });
        } catch { /* not a source */ }
    };
    const visit = (v) => {
        if (typeof v === 'string') {
            try { const parsed = JSON.parse(v); if (parsed && typeof parsed === 'object') return visit(parsed); } catch { /* text */ }
            for (const m of v.matchAll(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g)) add(m[2], m[1]);
            for (const m of v.matchAll(/https:\/\/[^\s<>"\])]+/g)) if (!found.has(m[0])) add(m[0]);
        } else if (Array.isArray(v)) v.forEach(visit);
        else if (v && typeof v === 'object') {
            if (v.url || v.link) add(v.url || v.link, v.title || v.name);
            for (const [k, x] of Object.entries(v)) if (!['url', 'link', 'title', 'name'].includes(k)) visit(x);
        }
    };
    visit(value);
    return [...found.values()];
}
function initial(id, product, at) {
    return { id, product, at, seq: 0, source: 0, status: 'running', plan: [], steps: [], sources: [], tools: {}, group: null, terminal: false };
}
function createMapper(state, { clean = (x) => x, fallback = async () => null } = {}) {
    const events = [];
    let at = state.at;
    const emit = (type, body = {}, ov = {}) => {
        const event = clean({ type, timestamp: Number.isFinite(Date.parse(at)) ? Date.parse(at) : Number(at) || 0, ...body,
            metadata: { ov: { product: state.product, ref: state.id, ...ov } } });
        events.push({ seq: ++state.seq, event });
    };
    const text = (content) => {
        if (!content) return;
        const messageId = `${state.id}:message:${state.seq + 1}`;
        emit('TEXT_MESSAGE_START', { messageId, role: 'assistant' });
        emit('TEXT_MESSAGE_CONTENT', { messageId, delta: String(content) });
        emit('TEXT_MESSAGE_END', { messageId });
        state.group = null;
    };
    async function push(raw, source, timestamp) {
        const l = clean(raw || {});
        at = timestamp || state.at;
        if (!state.seq) emit('RUN_STARTED', { runId: state.id, threadId: state.id });
        if (state.terminal) return;
        if (l.t === 'tool') {
            const id = `${state.id}:${l.attempt || 1}:${source}`;
            let label = titleFor(l.name, l.input || l.what);
            const cacheKey = require('node:crypto').createHash('sha256').update(JSON.stringify([l.name, target(l.input || l.what)])).digest('hex');
            state.titles = state.titles || {};
            if (!label && state.titles[cacheKey]) label = state.titles[cacheKey];
            if (!label) label = { kind: 'run', title: oneLine(await fallback(l.name, l.input || l.what)) || 'Performed an action' };
            label = clean(label);
            state.titles[cacheKey] = label;
            if (!state.group || state.group.kind !== label.kind || state.group.parent !== (l.parent || null)) {
                state.group = { id, kind: label.kind, count: 0, parent: l.parent || null };
            }
            state.group.count++;
            const step = { id, tool: l.name || 'action', ...label, status: 'running', group_id: state.group.id, group_count: state.group.count, started_at: at };
            state.steps.push(step);
            state.tools[String(l.id || l.name || source)] = id;
            if (l.name) state.tools[l.name] = id;
            emit('STEP_STARTED', { stepName: id }, { ...label, group: { ...state.group } });
            emit('TOOL_CALL_START', { toolCallId: id, toolCallName: step.tool }, { ...label, group: { ...state.group } });
            emit('TOOL_CALL_ARGS', { toolCallId: id, delta: JSON.stringify(l.input || { target: l.what || '' }) });
            emit('TOOL_CALL_END', { toolCallId: id });
            if (Array.isArray(l.input && l.input.todos)) {
                state.plan = l.input.todos;
                emit('STATE_SNAPSHOT', { snapshot: { plan: state.plan } }, { title: 'Updated the plan', kind: 'plan' });
            }
        } else if (l.t === 'tool_result' || l.t === 'tool_progress') {
            const id = state.tools[String(l.id || l.name)] || state.tools[l.name];
            const step = state.steps.find((s) => s.id === id);
            if (!step) return;
            if (l.t === 'tool_progress') {
                emit('ACTIVITY_SNAPSHOT', { messageId: id, activityType: 'tool-progress', content: { text: l.chunk || '' } }, { title: step.title, kind: step.kind });
                return;
            }
            const output = typeof l.output === 'string' ? l.output : JSON.stringify(l.output || '');
            step.summary = oneLine(output);
            step.status = l.ok === false ? 'failed' : 'done';
            step.ended_at = at;
            const sources = ['search', 'fetch', 'browse'].includes(step.kind) ? sourcesIn([l.sources, l.output]) : [];
            const added = sources.filter((s) => !state.sources.some((old) => old.url === s.url));
            state.sources.push(...added);
            emit('TOOL_CALL_RESULT', { messageId: `${id}:result`, toolCallId: id, role: 'tool', content: output },
                { title: step.title, kind: step.kind, summary: step.summary, sources, ...(l.attachments ? { attachments: l.attachments } : {}) });
            emit('STEP_FINISHED', { stepName: id }, { title: step.title, kind: step.kind, status: step.status, group: state.group });
            if (added.length) emit('CUSTOM', { name: 'ov.sources', value: added }, { sources: added });
            if (l.ok === false) state.group = null;
        } else if (l.t === 'plan') {
            state.group = null;
            state.plan = l.plan || [{ title: l.text || 'Plan', status: 'running' }];
            emit('STATE_SNAPSHOT', { snapshot: { plan: state.plan } }, { title: 'Updated the plan', kind: 'plan' });
        } else if (l.t === 'approval') {
            state.group = null;
            state.status = 'needs_you';
            emit('CUSTOM', { name: 'ov.approval', value: l }, { title: oneLine(l.text || 'Waiting for you'), kind: 'ask', needs_you: { id: l.id || String(source), question: l.text || '', actions: l.actions || [] } });
        } else if (l.t === 'handoff') {
            state.group = null;
            emit('CUSTOM', { name: 'ov.handoff', value: l }, { title: oneLine(l.reason || 'Handed work to an agent'), kind: 'agent' });
        } else if (l.t === 'done') {
            state.result = { kind: 'text', text: l.text || '', ok: l.ok !== false };
            state.cost_usd = (state.cost_usd || 0) + (Number(l.cost_usd) || 0);
            // A harness attempt ending is not the end of a task that may retry.
            emit('CUSTOM', { name: 'ov.result', value: { kind: 'text', text: l.text || '', ok: l.ok !== false } }, { cost_usd: Number(l.cost_usd) || 0 });
            state.group = null;
        } else if (l.t === 'end') {
            for (const step of state.steps.filter((s) => s.status === 'running')) {
                step.status = l.ok === false ? 'failed' : 'done';
                emit('STEP_FINISHED', { stepName: step.id }, { title: step.title, kind: step.kind });
            }
            state.status = l.ok === false ? 'failed' : 'done';
            state.endedAt = at;
            state.terminal = true;
            emit(l.ok === false ? 'RUN_ERROR' : 'RUN_FINISHED', l.ok === false
                ? { message: oneLine(l.text || 'The run failed'), code: 'run.failed' } : { runId: state.id, threadId: state.id });
        } else if (l.t === 'think') {
            const messageId = `${state.id}:reasoning:${source}`;
            state.group = null;
            emit('REASONING_START');
            emit('REASONING_MESSAGE_START', { messageId, role: 'assistant' });
            if (l.text) emit('REASONING_MESSAGE_CONTENT', { messageId, delta: l.text });
            emit('REASONING_MESSAGE_END', { messageId });
            emit('REASONING_END');
        } else if (l.t === 'text' || l.t === 'note') text(l.text);
        else if (l.t === 'state') emit('ACTIVITY_SNAPSHOT', { messageId: state.id, activityType: 'status', content: { status: l.state } }, { title: oneLine(l.state), kind: 'note' });
    }
    return { push, events };
}
module.exports = { initial, createMapper, titleFor, sourcesIn, oneLine, target };
