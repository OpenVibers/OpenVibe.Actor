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

// HO1: a standing permission is matched on the step's target string, so a target names the step exactly: argv words
// are quoted when they hold anything but plain characters (two different commands never read the same), nothing is
// cut and no whitespace is folded. A step that cannot be named within allows.MAX_TARGET has no target, and so can
// never be always allowed.
const word = (w) => (/^[A-Za-z0-9_@%+=:,.\/-]+$/.test(w) ? w : JSON.stringify(w));
const raw = (v) => (typeof v === 'string' ? v : '');
const machineWord = (a) => (raw(a.machine) && a.machine !== 'any' ? word(a.machine) : 'your computer');
const MAX_TARGET = 200;
const exactTarget = (t) => (typeof t === 'string' && t.length > 0 && t.length <= MAX_TARGET && !/[\u0000-\u001f\u007f]/.test(t) ? t : null);
function runTarget(a) {
    if (!Array.isArray(a.argv) || !a.argv.length || !a.argv.every((x) => typeof x === 'string')) return null;
    return exactTarget(`${a.argv.map(word).join(' ')}${raw(a.cwd) ? ` in ${word(a.cwd)}` : ''} on ${machineWord(a)}`);
}
// What repeats and when, both, exactly: allowing a schedule must not allow whatever task rides on it.
function routineTarget(a) {
    const what = raw(a.task) || raw(a.request);
    const when = raw(a.cron) ? `cron ${word(a.cron)}${raw(a.timezone) ? ` ${word(a.timezone)}` : ''}`
        : (a.event && raw(a.event.pattern) ? `when ${word(a.event.pattern)}` : '');
    return what && when ? exactTarget(`${JSON.stringify(what)} ${when}`) : null;
}
/** The target of a coding task in one repository (the engine's own Codes gate uses it too). */
const repoTarget = (repo) => (raw(repo) ? exactTarget(`repo ${word(repo)}`) : null);
// Where a post or a publish lands, when the tool's input names it: the target is the tool and that place.
const DESTINATION_KEYS = ['site', 'host', 'url', 'channel', 'room', 'space_id', 'blog', 'board', 'community'];
function destinationOf(input) {
    const o = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    for (const k of DESTINATION_KEYS) if (typeof o[k] === 'string' && o[k]) return `${k} ${word(o[k])}`;
    return null;
}

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
                target: runTarget(a),
                payload: safeInput({ machine: a.machine, argv, cwd: a.cwd, desk: a.desk }),
            };
        }
        case 'computer_write': {
            const path = text(a.path, 300);
            return {
                act: 'edit',
                kind: 'computer.write',
                summary: `Write ${quoted(path, 220) || 'a file'} on your computer (${text(a.mode, 20) || 'create'})`,
                target: raw(a.path) ? exactTarget(`${word(raw(a.mode) || 'create')} ${word(a.path)} on ${machineWord(a)}`) : null,
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
                // Typing and clicking reach anything on the screen, a terminal included: never always allowed.
                target: null,
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
                // Only opening one exact address may be always allowed: a click or a fill acts on whatever page is open.
                target: action === 'open' && raw(a.url) ? exactTarget(`open ${word(a.url)} on ${machineWord(a)}`) : null,
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
                target: exactTarget(`${action === 'start' ? 'start' : 'stop'} the desk on ${machineWord(a)}`),
                payload: safeInput({ machine: a.machine, action, kind: a.kind, width: a.width, height: a.height }),
            };
        }
        case 'robot_steps':
            return {
                act: 'act',
                kind: 'robot.move',
                summary: `Move your robot ${text(a.robot, 80)}: ${quoted(commandOf(a.steps).join(', '), 220)}`,
                target: raw(a.robot) ? exactTarget(`robot ${word(a.robot)}`) : null,
                payload: safeInput({ robot: a.robot, steps: a.steps }),
            };

        // ── OpenVibe.Space: the person's own spaces ──
        case 'space_create':
            return {
                act: 'act',
                kind: 'space',
                summary: `Create a space${a.name ? ` ${quoted(a.name, 80)}` : ''} on OpenVibe.Space`,
                target: raw(a.name) ? exactTarget(`new space ${word(a.name)}`) : null,
                payload: safeInput({ name: a.name, description: a.description }),
            };
        case 'space_files_write':
            return {
                act: 'edit',
                kind: 'space',
                summary: `Write ${Array.isArray(a.files) ? Math.min(a.files.length, 20) : 0} file(s) in your space ${text(a.space_id, 64)}`,
                target: raw(a.space_id) ? exactTarget(`files of space ${word(a.space_id)}`) : null,
                payload: safeInput({ space_id: a.space_id, files: a.files }),
            };
        case 'space_publish':
            return {
                act: 'act',
                kind: 'publish',
                summary: `Publish your space ${text(a.space_id, 64)} on the open web`,
                target: raw(a.space_id) ? exactTarget(`publish space ${word(a.space_id)}`) : null,
                payload: safeInput({ space_id: a.space_id }),
            };

        // ── Coding on the person's machine ──
        case 'codes_task': {
            const repo = text(a.repo, 300);
            return {
                act: 'edit',
                kind: 'codes.task',
                summary: `Start a coding task on your machine${repo ? ` in ${repo}` : ''}`,
                target: repoTarget(a.repo),
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
                return { act: 'act', kind: 'actor.action', category: categories[0], summary, target: null, payload: safeInput(a.input) };
            }
            // Spending is the floor whatever the words say. A post or a publish may be allowed for one tool and one
            // place its input names; a send or an install never (kinds.NEVER_ALWAYS), so they carry no target.
            const floorCategory = kind === 'money' ? 'money' : categories[0];
            const dest = (kind === 'post' || kind === 'publish') ? destinationOf(a.input) : null;
            return {
                act: 'act', kind, ...(floorCategory ? { category: floorCategory } : {}), summary,
                target: dest && raw(a.tool) ? exactTarget(`${word(a.tool)} to ${dest}`) : null,
                payload: safeInput(a.input),
            };
        }

        // ── A routine: it keeps running after this turn, so the card says what and when in plain words ──
        case 'schedule_trigger': {
            const what = text(a.task || a.request, 160);
            const goal = a.goal && typeof a.goal === 'object' && a.goal.done_test ? text(a.goal.done_test, 200) : null;
            const when = a.cron ? `${text(a.cron, 40)}${a.timezone ? `, ${text(a.timezone, 40)}` : ''}`
                : (a.event && a.event.pattern ? `when ${text(a.event.pattern, 80)} happens` : '');
            return {
                act: 'act',
                kind: 'routine',
                summary: goal
                    ? `Keep working${when ? ` (${when})` : ''} until ${quoted(goal, 200)}, then stop: ${quoted(what, 160) || 'the goal you asked for'}`
                    : `Set up a task that repeats${when ? ` (${when})` : ''}: ${quoted(what, 160) || 'the one you asked for'}`,
                // What repeats and when, both: allowing a schedule must not allow whatever task rides on it.
                target: routineTarget(a),
                payload: safeInput({ request: a.request, task: a.task, cron: a.cron, timezone: a.timezone, event: a.event, agent_id: a.agent_id, goal: a.goal, notify: a.notify }),
            };
        }

        // ── Money: a tip to a creator, with the person's own Vibes (plan HO7) ──
        case 'spend_vibes': {
            const to = text(a.to, 120);
            const amount = Number(a.amount);
            const reason = text(a.reason, 300);
            const vibes = Number.isInteger(amount) && amount > 0 ? amount : 0;
            return {
                act: 'act',
                kind: 'money',
                // The floor: money always asks, at every level, and is never always allowed (agents/kinds.js).
                category: 'money',
                // The marker that says this money is a tip (plan HO7) and not some other money step: only a tip is
                // prepared, capped and paid at the person's approval.
                spend: true,
                summary: `Tip ${vibes} Vibes to ${to || 'a creator'}${reason ? `: ${reason}` : ''}`,
                target: to ? exactTarget(`tip ${vibes} Vibes to ${word(to)}`) : null,
                payload: { to, amount: vibes, reason },
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
                target: exactTarget(`tool ${word(String(name || ''))}`),
                payload: safeInput(a),
            };
    }
}

module.exports = { stepFor, deletes, safeInput, SECRET_KEYS, PASSWORD_FIELD, toolKind, TOOL_KINDS, repoTarget, runTarget };
