'use strict';

/**
 * Which acting tool steps must see the approval gate first (plan §12 A-2). The gate itself is the
 * engine's: levels.classify + levels.decide, then a row on /me/approvals. This module only says what
 * a tool call is — its act ('edit' or 'act') and an always-ask category when the call names one — and
 * keeps a secret out of the approval card and the payload.
 *
 * A tool that only reads or writes Actor's own working state (a file or chart of the task, a memory
 * note) returns null: reading the agent's own files never asks. The generic OpenVibe.Tools call is
 * gated only when its input falls in an always-ask category, so a DNS lookup stays a lookup.
 *
 *   stepFor(name, input) → { act, category, summary, payload, recipientKnown? } | null
 */

const levels = require('./levels');

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

function stepFor(name, input) {
    const a = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    switch (name) {
        // ── A person's computer (the old runtime and the modular tools share these names) ──
        case 'computer_run': {
            const argv = commandOf(a.argv);
            return {
                act: 'act',
                ...(deletes(argv) ? { category: 'delete' } : {}),
                summary: `Run ${quoted(argv.join(' '), 220) || 'a program'} on your computer`,
                payload: safeInput({ machine: a.machine, argv, cwd: a.cwd, desk: a.desk }),
            };
        }
        case 'computer_write': {
            const path = text(a.path, 300);
            return {
                act: 'edit',
                summary: `Write ${quoted(path, 220) || 'a file'} on your computer (${text(a.mode, 20) || 'create'})`,
                payload: safeInput({ machine: a.machine, path, mode: a.mode, text: a.text }, { removeText: true }),
            };
        }
        case 'computer_input': {
            const action = text(a.action, 20) || 'act';
            const password = PASSWORD_FIELD.test(text(a.keys, 80));
            return {
                act: 'act',
                ...(password ? { category: 'password' } : {}),
                summary: action === 'type' ? 'Type on your computer' : `Use ${action || 'the mouse or keyboard'} on your computer`,
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
                ...(password ? { category: 'password' } : {}),
                summary,
                payload: safeInput({ machine: a.machine, action, url: a.url, ref: a.ref, selector: a.selector, text: a.text, key: a.key, desk: a.desk }, { removeText: action === 'fill' }),
            };
        }
        case 'computer_desk': {
            const action = text(a.action, 20) || 'status';
            if (action === 'status') return null;
            return {
                act: 'act',
                summary: `${action === 'start' ? 'Start' : 'Stop'} your agent's desk${a.machine && a.machine !== 'any' ? ` on ${text(a.machine, 80)}` : ''}`,
                payload: safeInput({ machine: a.machine, action, kind: a.kind, width: a.width, height: a.height }),
            };
        }
        case 'robot_steps':
            return {
                act: 'act',
                summary: `Move your robot ${text(a.robot, 80)}: ${quoted(commandOf(a.steps).join(', '), 220)}`,
                payload: safeInput({ robot: a.robot, steps: a.steps }),
            };

        // ── OpenVibe.Space: the person's own spaces ──
        case 'space_create':
            return { act: 'act', summary: `Create a space${a.name ? ` ${quoted(a.name, 80)}` : ''} on OpenVibe.Space`, payload: safeInput({ name: a.name, description: a.description }) };
        case 'space_files_write':
            return {
                act: 'edit',
                summary: `Write ${Array.isArray(a.files) ? Math.min(a.files.length, 20) : 0} file(s) in your space ${text(a.space_id, 64)}`,
                payload: safeInput({ space_id: a.space_id, files: a.files }),
            };
        case 'space_publish':
            return { act: 'act', summary: `Publish your space ${text(a.space_id, 64)} on the open web`, payload: safeInput({ space_id: a.space_id }) };

        // ── Coding on the person's machine ──
        case 'codes_task': {
            const repo = text(a.repo, 300);
            return {
                act: 'edit',
                summary: `Start a coding task on your machine${repo ? ` in ${repo}` : ''}`,
                payload: safeInput({ instruction: a.instruction, repo }),
            };
        }

        // ── A generic OpenVibe.Tools tool: a lookup stays a lookup, a floor category asks ──
        case 'run_tool': {
            const summary = `Run the OpenVibe.Tools tool ${text(a.tool, 80)}`;
            const categories = levels.classify({ summary, payload: a.input });
            if (!categories.length) return null;
            return { act: 'act', category: categories[0], summary, payload: safeInput(a.input) };
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
            return { act: 'act', summary: `Use ${text(name, 80)}`, payload: safeInput(a) };
    }
}

module.exports = { stepFor, deletes, safeInput, SECRET_KEYS, PASSWORD_FIELD };
