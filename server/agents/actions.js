'use strict';

/**
 * Which acting tool steps must see the approval gate first (plan §12 A-2, plan HO1). The gate itself is the
 * engine's: levels.classify + levels.decide, then a row on /me/approvals. This module only says what
 * a tool call is — its kind (agents/kinds.js), its act ('edit' or 'act'), an always-ask category when the call
 * names one, the exact target it would touch — and keeps a secret out of the approval card and the payload.
 *
 * A tool that only reads or writes Actor's own working state (a file or chart of the task, a memory
 * note) returns null: reading the agent's own files never asks. The generic OpenVibe.Tools call is
 * gated only when the tool it runs is a consequential one, so a DNS lookup stays a lookup.
 *
 *   stepFor(name, input) → { act, kind, category?, summary, target, payload, recipientKnown? } | null
 */

const levels = require('./levels');
const kinds = require('./kinds');

const SECRET_KEYS = new Set(['password', 'passwd', 'passcode', 'secret', 'token', 'api_key', 'apikey', 'apiKey', 'access_token', 'refresh_token', 'private_key', 'card_number', 'cvv', 'cvc']);
const DELETE_CMD = /^(?:rm|rmdir|del|erase|shred|truncate|unlink|srm|rd)$/i;
const PASSWORD_FIELD = /\b(password|passwd|passphrase|passcode|otp|2fa|two-factor|secret|token|api.?key|card.?number|cvv|cvc|security.?code)\b/i;

const text = (v, n = 200) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const quoted = (v, n = 120) => (v ? `"${text(v, n)}"` : '');

/** A copy of the input with credentials removed (a card or a password never reaches the approvals table). */
function safeInput(input, { removeText = false } = {}) {
    const out = {};
    for (const [k, v] of Object.entries(input && typeof input === 'object' ? input : {})) {
        if (SECRET_KEYS.has(k)) out[k] = '[redacted]';
        else if (removeText && k === 'text') out[k] = '[redacted]';
        else if (k === 'files' && Array.isArray(v)) out[k] = v.slice(0, 20).map((f) => ({ path: text(f && f.path, 80), content: '[not shown]' }));
        else if (k === 'content' || k === 'text') out[k] = k === 'content' ? '[not shown]' : text(v, 300);
        else if (typeof v === 'string') out[k] = text(v, 300);
        else if (Array.isArray(v)) out[k] = v.slice(0, 30).map((x) => (typeof x === 'string' ? text(x, 120) : x));
        else out[k] = v;
    }
    return out;
}

const commandOf = (argv) => (Array.isArray(argv) ? argv.map((a) => text(a, 120)) : []);

/** Does this argv delete files (rm, del, shred, truncate, unlink, …)? */
function deletes(argv) {
    const parts = commandOf(argv);
    return parts.some((a, i) => DELETE_CMD.test(a) || (i > 0 && /\b(?:rm|del|erase|shred|truncate|unlink)\b/i.test(a)));
}

/** The machine a step would touch, in the person's words. */
const machineOf = (a) => text(a.machine, 60) || 'your computer';

// The kinds an OpenVibe.Tools tool may be, by its id. The first match wins, so the order is the order of
// the trust: an install is an install, even when its name also says "post".
const TOOL_KINDS = [
    [/^(install|installer|connector|connect|skill|skills)$/, 'install'],
    [/^(pay|payment|payments|purchase|buy|checkout|charge|refund|transfer|wallet|vibes|vibe|balance|invoice|subscription|money|spend|topup)$/, 'money'],
    [/^(publish|publisher)$/, 'publish'],
    [/^(send|sender|email|mail|message|dm|notify|sms|telegram|discord|whatsapp)$/, 'send'],
    [/^(post|comment|reply|share)$/, 'post'],
];

/** The kind of an OpenVibe.Tools tool by its id, or null when the tool is a plain lookup. */
function toolKind(tool) {
    const words = String(tool || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    for (const [re, kind] of TOOL_KINDS) if (words.some((w) => re.test(w))) return kind;
    return null;
}

function stepFor(name, input) {
    const a = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    switch (name) {
        // ── A person's computer (the old runtime and the modular tools share these names) ──
        case 'computer_run': {
            const argv = commandOf(a.argv);
            const line = argv.join(' ');
            return {
                act: 'act',
                kind: 'computer.run',
                ...(deletes(argv) ? { category: 'delete' } : {}),
                summary: `Run ${quoted(line, 220) || 'a program'} on your computer`,
                target: `${line || 'a program'} on ${machineOf(a)}`,
                payload: safeInput({ machine: a.machine, argv, cwd: a.cwd, desk: a.desk }),
            };
        }
        case 'computer_write': {
            const path = text(a.path, 300);
            return {
                act: 'edit',
                kind: 'computer.write',
                summary: `Write ${quoted(path, 220) || 'a file'} on your computer (${text(a.mode, 20) || 'create'})`,
                target: `${path || 'a file'} on ${machineOf(a)}`,
                payload: safeInput({ machine: a.machine, path, mode: a.mode, text: a.text }, { removeText: true }),
            };
        }
        case 'computer_input': {
            const action = text(a.action, 20) || 'act';
            const password = PASSWORD_FIELD.test(text(a.keys, 80));
            return {
                act: 'act',
                kind: 'computer.input',
                ...(password ? { category: 'password' } : {}),
                summary: action === 'type' ? 'Type on your computer' : `Use ${action || 'the mouse or keyboard'} on your computer`,
                target: `${action} on ${machineOf(a)}`,
                payload: safeInput({ machine: a.machine, action, x: a.x, y: a.y, keys: a.keys, text: a.text }, { removeText: action === 'type' }),
            };
        }
        case 'computer_browser': {
            const action = text(a.action, 20) || 'open';
            if (action === 'read' || action === 'close') return null;   // reading and closing never wait
            const target = action === 'fill' ? text(a.selector || a.ref, 220) : text(a.text || a.selector || a.ref || a.url, 220);
            const password = PASSWORD_FIELD.test(`${text(a.selector, 120)} ${text(a.ref, 120)}`);
            const summary = action === 'open' ? `Open ${quoted(a.url, 220)} in your browser`
                : action === 'fill' ? `Fill ${quoted(target, 180) || 'a field'} in your browser`
                    : action === 'click' ? `Click ${quoted(target, 180) || 'an element'} in your browser`
                        : `${text(a.action, 20) || 'Use'} the browser on your computer`;
            return {
                act: 'act',
                kind: 'computer.browser',
                ...(password ? { category: 'password' } : {}),
                summary,
                target: `${action} ${target || 'the page'} on ${machineOf(a)}`,
                payload: safeInput({ machine: a.machine, action, url: a.url, ref: a.ref, selector: a.selector, text: a.text, key: a.key, desk: a.desk }, { removeText: action === 'fill' }),
            };
        }
        case 'computer_desk': {
            const action = text(a.action, 20) || 'status';
            if (action === 'status') return null;
            return {
                act: 'act',
                kind: 'computer.desk',
                summary: `${action === 'start' ? 'Start' : 'Stop'} your agent's desk${a.machine && a.machine !== 'any' ? ` on ${text(a.machine, 80)}` : ''}`,
                target: `desk on ${machineOf(a)}`,
                payload: safeInput({ machine: a.machine, action, kind: a.kind, width: a.width, height: a.height }),
            };
        }
        case 'robot_steps':
            return {
                act: 'act',
                kind: 'robot.move',
                summary: `Move your robot ${text(a.robot, 80)}: ${quoted(commandOf(a.steps).join(', '), 220)}`,
                target: `robot ${text(a.robot, 60) || 'unknown'}`,
                payload: safeInput({ robot: a.robot, steps: a.steps }),
            };

        // ── OpenVibe.Space: the person's own spaces ──
        case 'space_create':
            return {
                act: 'act',
                kind: 'space',
                summary: `Create a space${a.name ? ` ${quoted(a.name, 80)}` : ''} on OpenVibe.Space`,
                target: `space ${text(a.name, 60) || 'new'}`,
                payload: safeInput({ name: a.name, description: a.description }),
            };
        case 'space_files_write':
            return {
                act: 'edit',
                kind: 'space',
                summary: `Write ${Array.isArray(a.files) ? Math.min(a.files.length, 20) : 0} file(s) in your space ${text(a.space_id, 64)}`,
                target: `space ${text(a.space_id, 64) || 'unknown'}`,
                payload: safeInput({ space_id: a.space_id, files: a.files }),
            };
        case 'space_publish':
            return {
                act: 'act',
                kind: 'publish',
                summary: `Publish your space ${text(a.space_id, 64)} on the open web`,
                target: `space ${text(a.space_id, 64) || 'unknown'}`,
                payload: safeInput({ space_id: a.space_id }),
            };

        // ── Coding on the person's machine ──
        case 'codes_task': {
            const repo = text(a.repo, 300);
            return {
                act: 'edit',
                kind: 'codes.task',
                summary: `Start a coding task on your machine${repo ? ` in ${repo}` : ''}`,
                target: repo ? `repo ${repo}` : 'any repository',
                payload: safeInput({ instruction: a.instruction, repo }),
            };
        }

        // ── A generic OpenVibe.Tools tool: a lookup stays a lookup, a consequential one asks ──
        case 'run_tool': {
            const tool = text(a.tool, 80);
            const summary = `Run the OpenVibe.Tools tool ${tool}`;
            const kind = toolKind(tool);
            const categories = levels.classify({ summary, payload: a.input });
            if (!kind) {
                // A tool whose name says nothing may still be a payment or a deletion: the floor decides.
                if (!categories.length) return null;
                return { act: 'act', kind: 'actor.action', category: categories[0], summary, target: tool, payload: safeInput(a.input) };
            }
            return { act: 'act', kind, category: categories[0] || undefined, summary, target: tool, payload: safeInput(a.input) };
        }

        // ── A routine: it keeps running after this turn, so the card says what and when in plain words ──
        case 'schedule_trigger': {
            const what = text(a.task || a.request, 160);
            const when = a.cron ? `${text(a.cron, 40)}${a.timezone ? `, ${text(a.timezone, 40)}` : ''}`
                : (a.event && a.event.pattern ? `when ${text(a.event.pattern, 80)} happens` : '');
            return {
                act: 'act',
                kind: 'routine',
                summary: `Set up a task that repeats${when ? ` (${when})` : ''}: ${quoted(what, 160) || 'the one you asked for'}`,
                target: when || text(a.task || a.request, 80) || 'a repeating task',
                payload: safeInput({ request: a.request, task: a.task, cron: a.cron, timezone: a.timezone, event: a.event, agent_id: a.agent_id }),
            };
        }

        // ── Actor's own working state: never asks ──
        case 'make_file':
        case 'make_chart':
        case 'remember':
        case 'hand_to_person':
        case 'wait_for':
            return null;

        // A connector (MCP/A2A) tool this Actor does not know: its acts:true says it may change something.
        default:
            return {
                act: 'act',
                kind: 'actor.action',
                summary: `Use ${text(name, 80)}`,
                target: text(name, 60),
                payload: safeInput(a),
            };
    }
}

module.exports = { stepFor, deletes, safeInput, SECRET_KEYS, PASSWORD_FIELD, toolKind, TOOL_KINDS };
