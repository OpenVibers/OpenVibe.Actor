'use strict';

/**
 * The person's own computers on OpenVibe.Bot, as runtime tools (plan T14/T17): OpenVibe.Node's computer plugin, reached
 * only through Bot. Actor calls Bot's public API with its own service token (audience openvibe.bot,
 * bot.computer.control) and X-OV-Subject naming the person the task is for. Bot answers only for the machine's owner,
 * and only where that owner turned on "Let my agent use this computer"; the level the owner set on the machine itself
 * decides what may happen there (observe, ask — which waits for their approval on the machine — trusted, full).
 *
 *   createComputers({ config, fetchImpl, tokens? }) → { enabled, mine(subject), list, read, run, write }
 *     mine  → [{ id, name, online, level, can: [terminal|files|screen], folders, waiting }] or { error }
 *     list  → { path, entries: [{ name, type, size }], truncated }      (a folder)
 *     read  → { path, size, text | bytes, truncated }                   (a file, as text when it is UTF-8)
 *     run   → { exit_code, stdout, stderr, truncated, timed_out }       (a program and its arguments, never a shell line)
 *     write → { path, written }                                          (create, overwrite or append)
 *     screen → { format, width, height, content_b64 }                    (the screen now, scaled to max_width)
 *     input → { done, action, x?, y? }                                  (mouse, scroll, typing or a key, as the person)
 *
 * Off (enabled false) without ACTOR_BOT_URL or without Actor's client secret.
 */
const { serviceAuth } = require('openvibe-contracts');

const MACHINE_ID = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;
const USER_SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
// A command waits on the machine for its owner's approval at level "ask", then runs: two minutes, inside a task's three.
const ACT_WINDOW_MS = 120_000;
const READ_WINDOW_MS = 30_000;
const MAX_READ = 64 * 1024;
// Wide enough to read a window's text, small enough that one look stays a few cents.
const SCREEN_WIDTH = 1280;
const INPUT_ACTIONS = new Set(['move', 'click', 'double_click', 'right_click', 'scroll', 'type', 'key']);
const POINT_ACTIONS = new Set(['move', 'click', 'double_click', 'right_click']);

function createComputers({ config, fetchImpl = globalThis.fetch, tokens: tokensOverride = null }) {
    const base = config.services.botUrl;
    const pages = config.services.botPublicUrl || base;
    const enabled = !!(base && (tokensOverride || config.oauth.clientSecret));
    const tokens = !enabled ? null : tokensOverride || serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.bot', scope: 'bot.computer.control', fetchImpl,
    });

    async function call(method, path, subject, { body, signal, timeoutMs = 15_000 } = {}) {
        const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
        const res = await fetchImpl(`${base}/api/v1${path}`, {
            method,
            headers: { Accept: 'application/json', 'X-OV-Subject': subject, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await tokens.authHeaders()) },
            body: body ? JSON.stringify(body) : undefined, signal: sig,
        });
        const data = await res.json().catch(() => null);
        return { status: res.status, ok: res.ok, data };
    }
    const problem = (r, what) => ({ error: (r.data && (r.data.detail || r.data.title)) || `Bot answered ${r.status} for ${what}`, code: (r.data && r.data.code) || null });
    const guard = (subject, machine) => {
        if (!USER_SUBJECT.test(subject)) return { error: 'computers are only for a signed-in person' };
        if (!MACHINE_ID.test(String(machine || ''))) return { error: 'machine must be a machine id from list_my_computers (dev_…)' };
        return null;
    };
    /** One command through Bot; the machine's answer, or its refusal (a nack's reason), as an error. */
    async function command(subject, machine, kind, value, { signal, windowMs }) {
        const r = await call('POST', `/machines/${machine}/commands`, subject, { body: { kind, value, ms: windowMs }, signal, timeoutMs: windowMs + 10_000 });
        if (!r.ok) return problem(r, `the ${kind} command`);
        if (r.data.result === 'ack') return { data: r.data.data || {} };
        if (r.data.result === 'expired') return { error: 'the machine did not answer in time (at level "ask", nobody approved it there)' };
        return { error: r.data.reason || `the machine refused it (${r.data.result})` };
    }

    async function mine(subject, { signal } = {}) {
        if (!USER_SUBJECT.test(subject)) return { error: 'computers are only for a signed-in person' };
        const r = await call('GET', '/machines', subject, { signal });
        if (!r.ok) return problem(r, 'your computers');
        const machines = ((r.data && r.data.machines) || []).filter((m) => m.computer).map((m) => ({
            id: m.id, name: m.name, online: m.online, level: m.computer.level,
            can: ['terminal', 'files', 'screen', 'input'].filter((k) => m.computer[k]),
            folders: (m.computer.files && m.computer.files.roots) || [],
            ...(m.computer.waiting ? { waiting_for_approval: m.computer.waiting } : {}),
        }));
        if (!machines.length) return { computers: [], note: `No computer is open to the agent. On ${pages}/machines the person adds one with --computer (for example "ask") and turns on "Let my agent use this computer".` };
        return { computers: machines, note: 'At level "observe" only reading works; at "ask" each run or write waits for the person to approve it on that machine.' };
    }

    async function list(subject, machine, path, { signal } = {}) {
        const bad = guard(subject, machine);
        if (bad) return bad;
        const r = await command(subject, machine, 'fs', { op: 'list', path: String(path || '') }, { signal, windowMs: READ_WINDOW_MS });
        if (r.error) return r;
        return { path: r.data.path, entries: (r.data.entries || []).slice(0, 300).map((e) => ({ name: e.name, type: e.type, size: e.size })), truncated: !!r.data.truncated || (r.data.entries || []).length > 300 };
    }

    async function read(subject, machine, path, { offset = 0, signal } = {}) {
        const bad = guard(subject, machine);
        if (bad) return bad;
        const off = Number.isInteger(offset) && offset > 0 ? offset : 0;
        const r = await command(subject, machine, 'fs', { op: 'read', path: String(path || ''), offset: off, length: MAX_READ }, { signal, windowMs: READ_WINDOW_MS });
        if (r.error) return r;
        const bytes = Buffer.from(String(r.data.content_b64 || ''), 'base64');
        const text = bytes.toString('utf8');
        const binary = text.includes('�') || /[\u0000-\u0008\u000e-\u001f]/.test(text);
        return { path: r.data.path, size: r.data.size, offset: off, ...(binary ? { bytes: bytes.length, note: 'not text' } : { text }), truncated: !!r.data.truncated };
    }

    async function run(subject, machine, argv, { cwd = null, timeoutS = null, signal } = {}) {
        const bad = guard(subject, machine);
        if (bad) return bad;
        if (!Array.isArray(argv) || !argv.length || argv.length > 64 || !argv.every((a) => typeof a === 'string' && a.length && a.length <= 4096)) {
            return { error: 'argv is a program and its arguments, for example ["git", "status"]: never a shell line' };
        }
        const value = { argv };
        if (cwd) value.cwd = String(cwd);
        if (Number.isInteger(timeoutS) && timeoutS > 0) value.timeout_s = Math.min(timeoutS, 600);
        const r = await command(subject, machine, 'exec', value, { signal, windowMs: ACT_WINDOW_MS });
        if (r.error) return r;
        const d = r.data;
        return { exit_code: d.exit_code, stdout: d.stdout, stderr: d.stderr, truncated: !!d.truncated, timed_out: !!d.timed_out };
    }

    async function write(subject, machine, path, text, { mode = 'create', signal } = {}) {
        const bad = guard(subject, machine);
        if (bad) return bad;
        if (typeof text !== 'string') return { error: 'text is the file\'s content' };
        const content = Buffer.from(text, 'utf8');
        if (content.length > 256 * 1024) return { error: 'at most 256 KB per write' };
        if (!['create', 'overwrite', 'append'].includes(mode)) return { error: 'mode is create, overwrite or append' };
        const r = await command(subject, machine, 'fs', { op: 'write', path: String(path || ''), content_b64: content.toString('base64'), mode }, { signal, windowMs: ACT_WINDOW_MS });
        if (r.error) return r;
        return { path: r.data.path, written: r.data.written };
    }

    /** The machine's screen now, as an image (JPEG when the machine has Pillow, else PNG), at most `maxWidth` wide. */
    async function screen(subject, machine, { maxWidth = SCREEN_WIDTH, signal } = {}) {
        const bad = guard(subject, machine);
        if (bad) return bad;
        const r = await command(subject, machine, 'screen', { max_width: maxWidth }, { signal, windowMs: READ_WINDOW_MS });
        if (r.error) return r;
        const d = r.data;
        if (!d.content_b64 || !/^(jpeg|png)$/.test(String(d.format || ''))) return { error: 'the machine sent no picture of its screen' };
        return { format: d.format, width: d.width, height: d.height, content_b64: d.content_b64 };
    }

    /**
     * Mouse, scroll, typing or one key on the machine (contracts 0.171.0 `input`): an acting command, so at level "ask"
     * it waits for the owner's approval there. x, y are measured in a screen picture of width × height (computer_screen's).
     */
    async function input(subject, machine, args, { signal } = {}) {
        const bad = guard(subject, machine);
        if (bad) return bad;
        const a = args && typeof args === 'object' ? args : {};
        if (!INPUT_ACTIONS.has(a.action)) return { error: `action is one of ${[...INPUT_ACTIONS].join(', ')}` };
        const value = { action: a.action };
        const int = (v) => Number.isInteger(v) ? v : (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
        if (POINT_ACTIONS.has(a.action) || (a.action === 'scroll' && a.x != null)) {
            const x = int(a.x), y = int(a.y);
            if (x == null || y == null || x < 0 || y < 0) return { error: `${a.action} needs x and y (pixels in the screen picture)` };
            Object.assign(value, { x, y });
            const w = int(a.width), h = int(a.height);
            if (w && h) Object.assign(value, { width: w, height: h });
        }
        if (a.action === 'scroll') {
            const dy = int(a.dy);
            if (!dy || Math.abs(dy) > 20) return { error: 'scroll needs dy: clicks, -20 (up) to 20 (down), not 0' };
            value.dy = dy;
        }
        if (a.action === 'type') {
            if (typeof a.text !== 'string' || !a.text || a.text.length > 2000) return { error: 'type needs text (1 to 2000 characters)' };
            value.text = a.text;
        }
        if (a.action === 'key') {
            if (typeof a.keys !== 'string' || !/^[A-Za-z0-9_+-]{1,64}$/.test(a.keys) || a.keys.startsWith('-')) return { error: 'key needs keys: one key or chord, for example Return, Escape, ctrl+s' };
            value.keys = a.keys;
        }
        const r = await command(subject, machine, 'input', value, { signal, windowMs: ACT_WINDOW_MS });
        if (r.error) return r;
        return { done: !!r.data.done, action: r.data.action || a.action, ...(r.data.x != null ? { x: r.data.x, y: r.data.y } : {}) };
    }

    return { enabled, mine, list, read, run, write, screen, input };
}

module.exports = { createComputers };
