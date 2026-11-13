'use strict';

/**
 * The tool registry (Actor v2, stage V2-1).
 *
 * Every capability is one module in this folder. Drop a file in and it is offered to the loop; no core file changes.
 * A module exports one plain object:
 *
 *   module.exports = {
 *     name: 'weather_now',                       // unique, snake_case
 *     description: 'Current weather …',          // what the model reads
 *     input: { type: 'object', properties: { place: { type: 'string' } }, required: ['place'] },  // JSON schema
 *     scope: 'public',                           // public | person | private-ok
 *     acts: true,                                // changes something outside the model: a checkpoint pauses a resume
 *     costUsd: 0,                                // estimated per call, for the planner
 *     timeoutMs: 15_000,
 *     async run(input, ctx) {                    // ctx: { fetch, signal, requester, emit, meter, config, log, artifacts }
 *       return { text: '…', data: { … }, sources: [{ url, title }], artifacts: [] };
 *     },
 *   };
 *
 * Scope says who may be offered the tool and where it may run:
 *   public      anyone; it may reach the public network
 *   person      only a signed-in person's task (the tool acts for them)
 *   private-ok  no network: it is the only kind private mode offers
 *
 * `acts: true` says the tool changes something outside the model's own reasoning: it writes, sends, starts or moves
 * something (a robot, a computer, a desk, a coding task, a file, a memory, or another tool that may). The loop records
 * a started mark and checkpoints it before such a call, so a restart never runs it again without the person deciding.
 * A read-only tool omits it (or says false). Every module must decide: test/tool-acts.test.js lists the whole set.
 *
 * The loader validates every module's shape at boot. In tests a bad module throws (a broken file fails tests, never
 * production); in production it is logged and skipped. Fixtures, helpers (`_name.js`) and non-JavaScript files are
 * ignored, so a module may keep its own data beside it.
 *
 * createRegistry({ dir, log, strict, config, fetchImpl }) → {
 *   tools, byName, errors, definitions(ctx), run(name, input, ctx), get(name), has(name), report()
 * }
 * `definitions(ctx)` answers the OpenAI function tools the model may call, filtered by scope: private mode sees only
 * private-ok tools; a task with no signed-in requester never sees `person` tools. A module may also export
 * `available(ctx)` to narrow itself further (a service that is not connected this boot).
 *
 * A module says what it `needs` of the person's files and of the open web (plan 11c, runtime/run-policy.js):
 * `needs: { files: 'none' | 'read' | 'write', network: true | false }`; without it, files none and network on. A run
 * whose settings do not give a tool what it needs leaves it out of the list, and `run()` refuses it in one line. The
 * permission rules (the site's, then the person's; the last match wins) deny, ask or allow each call before the
 * approval level is asked; an allow never lowers the always-ask floor.
 *
 * A module may name its `connector`: one of the ids in server/runtime/connectors.js (the group of tools that
 * reaches one OpenVibe service). A module without one is a core tool and is always on. The connectors that are off
 * for the requester — the owner's switch and the person's own — leave their tools out of the list, and `run()`
 * refuses them with the line that says where to turn the connector on.
 */

const fs = require('fs');
const path = require('path');
const { stepFor } = require('../../agents/actions');
const connectors = require('../connectors');
const runPolicy = require('../run-policy');

const SCOPES = ['public', 'person', 'private-ok'];
const NAME = /^[a-z][a-z0-9_]{1,63}$/;
const MAX_TIMEOUT_MS = 900_000;
const DEFAULT_TIMEOUT_MS = 15_000;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Every problem with one module's shape; empty when it is a valid tool. */
function validateTool(mod) {
    const errors = [];
    if (!isObject(mod)) return ['the module must export an object'];
    if (typeof mod.name !== 'string' || !NAME.test(mod.name)) errors.push('name: snake_case, 2–64 characters, starting with a letter');
    if (typeof mod.description !== 'string' || !mod.description.trim()) errors.push('description: a non-empty string');
    if (!isObject(mod.input)) errors.push('input: a JSON schema object');
    else if (mod.input.type !== 'object') errors.push('input.type must be "object"');
    else if (mod.input.properties != null && !isObject(mod.input.properties)) errors.push('input.properties must be an object');
    if (!SCOPES.includes(mod.scope)) errors.push(`scope: one of ${SCOPES.join(', ')}`);
    if (mod.acts != null && typeof mod.acts !== 'boolean') errors.push('acts: true or false (omit it for a read-only tool)');
    if (mod.costUsd != null && !(Number.isFinite(mod.costUsd) && mod.costUsd >= 0)) errors.push('costUsd: a number, 0 or more');
    if (mod.timeoutMs != null && !(Number.isInteger(mod.timeoutMs) && mod.timeoutMs > 0 && mod.timeoutMs <= MAX_TIMEOUT_MS)) errors.push(`timeoutMs: an integer from 1 to ${MAX_TIMEOUT_MS}`);
    if (mod.connector != null && !connectors.isConnectorId(mod.connector)) errors.push(`connector: one of ${connectors.CONNECTOR_IDS.join(', ')}`);
    errors.push(...runPolicy.needsProblems(mod.needs));
    if (typeof mod.run !== 'function') errors.push('run: a function (input, ctx)');
    return errors;
}

/** The tool names a caller may see, by scope. */
function allowedBy(scope, { requester, mode } = {}) {
    if (mode === 'private') return scope === 'private-ok';
    if (scope === 'private-ok') return true;
    if (scope === 'person') return typeof requester === 'string' && requester.startsWith('user:');
    return scope === 'public';
}

/**
 * Load and validate every module in `dir` (default: this folder). `strict` throws on the first bad module (tests and
 * boot in test mode); otherwise bad modules are logged and skipped (production never dies on a plugin).
 */
function createRegistry({ dir = __dirname, log = console, strict = false, fetchImpl = globalThis.fetch } = {}) {
    const byName = new Map();
    const errors = [];

    let files = [];
    try {
        files = fs.readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isFile() && d.name.endsWith('.js') && d.name !== 'index.js' && !d.name.startsWith('_'))
            .map((d) => d.name)
            .sort();
    } catch (err) {
        errors.push({ file: dir, errors: [`cannot read the tools folder: ${(err && err.message) || err}`] });
    }

    for (const file of files) {
        const full = path.join(dir, file);
        let mod;
        try {
            delete require.cache[require.resolve(full)];
            mod = require(full);
        } catch (err) {
            errors.push({ file, errors: [`require failed: ${(err && err.message) || err}`] });
            continue;
        }
        const problems = validateTool(mod);
        if (problems.length) {
            errors.push({ file, errors: problems });
            continue;
        }
        if (byName.has(mod.name)) {
            errors.push({ file, errors: [`duplicate tool name "${mod.name}" (already loaded)`] });
            continue;
        }
        byName.set(mod.name, { ...mod, file });
    }

    if (errors.length) {
        const text = errors.map((e) => `${e.file}: ${e.errors.join('; ')}`).join('\n');
        if (strict) throw new Error(`invalid tool module(s):\n${text}`);
        if (log && log.warn) log.warn(`[Actor] tool modules skipped:\n${text}`);
    }

    const get = (name) => byName.get(name) || null;
    const has = (name) => byName.has(name);

    /** Is this connector off for the requester of this run (the owner's switch, then the person's own)? */
    const connectorOff = (ctx, id) => {
        const sw = ctx && ctx.connectorSwitches;
        return Boolean(sw && sw.off && sw.off.has(id));
    };

    /** The run's settings and rules (plan 11c), or null for a caller that has none (a test, an old path). */
    const policyOf = (ctx) => (ctx && ctx.runPolicy && typeof ctx.runPolicy === 'object' ? ctx.runPolicy : null);
    /** A rule that denies the tool whatever its input: the tool is left out of the list, so the model never tries. */
    const deniedOutright = (policy, tool) => {
        const d = runPolicy.decide(policy, { tool, args: null });
        return Boolean(d && d.decision === 'deny');
    };

    /** The OpenAI function definitions for this task, filtered by scope, by the module's optional `available(ctx)` and by the connectors that are off. */
    function definitions(ctx = {}) {
        const { requester = null, mode = null } = ctx;
        return [...byName.values()]
            .filter((t) => allowedBy(t.scope, { requester, mode }) && require('../../chat-apps/policy').allowed(t, ctx.chatPolicy))
            .filter((t) => (typeof t.available === 'function' ? t.available(ctx) !== false : true))
            .filter((t) => !t.connector || !connectorOff(ctx, t.connector))
            .filter((t) => !policyOf(ctx) || (!runPolicy.settingsRefusal(policyOf(ctx).settings, t) && !deniedOutright(policyOf(ctx), t)))
            .map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.input },
            }));
    }

    /**
     * Run one tool by name with a per-tool timeout, composing it with the task's abort signal. Errors come back as
     * text (the model sees them) and never throw unless the task itself was cancelled. A `person` tool refuses a task
     * with no signed-in person, and private mode refuses any tool that is not private-ok.
     */
    async function run(name, input, ctx = {}) {
        // A connector tool (stage V2-11: an MCP server or an A2A agent) is not a file in this folder: the run built
        // it for this person and passes it in the context, so only the tools this run may use are here.
        const dynamic = ctx && ctx.dynamicTools ? ctx.dynamicTools.get(name) : null;
        const tool = byName.get(name) || dynamic;
        if (!tool) return { text: JSON.stringify({ error: `unknown tool ${name}` }), data: null, sources: [], isError: true };
        if (!allowedBy(tool.scope, ctx)) return { text: JSON.stringify({ error: `tool ${name} is not available for this task` }), data: null, sources: [], isError: true };
        // The connectors (plan §Z.6): a tool whose connector is off for this requester does not run, and the model is
        // told in one plain line where to turn it on. A connector with a daily cap counts this call before it runs.
        if (tool.connector) {
            const sw = ctx && ctx.connectorSwitches;
            if (sw && sw.off && sw.off.has(tool.connector)) {
                return normalize({ text: JSON.stringify({ error: connectors.offMessage(tool.connector) }), isError: true });
            }
            const cap = sw && sw.connectors && sw.connectors[tool.connector] ? sw.connectors[tool.connector].cap : null;
            if (cap != null && sw && typeof sw.take === 'function') {
                const taken = await sw.take(tool.connector, cap);
                if (!taken.ok) return normalize({ text: JSON.stringify({ error: connectors.capMessage(tool.connector, cap) }), isError: true });
            }
        }
        if (!require('../../chat-apps/policy').allowed(tool, ctx.chatPolicy)) return normalize({ text: 'This tool is unavailable in this chat.', isError: true });
        // The run's settings and the permission rules (plan 11c): what the run may touch, then the site's rules and
        // the person's. A deny ends here with its reason; an allow or an ask goes on to the approval gate below.
        const policy = policyOf(ctx);
        let rule = null;
        if (policy) {
            const refused = runPolicy.settingsRefusal(policy.settings, tool);
            if (refused) return normalize({ text: JSON.stringify({ error: `not run: ${refused}` }), data: { refused, setting: true }, isError: true });
            rule = runPolicy.decide(policy, { tool, args: input && typeof input === 'object' ? input : {} });
            if (rule && rule.decision === 'deny') {
                return normalize({ text: JSON.stringify({ error: `not run: ${rule.why}` }), data: { refused: rule.why, rule: { source: rule.source, index: rule.index } }, isError: true });
            }
        }
        let dayApproved = false;
        if (ctx.day) {
            const gate = await ctx.day.guardTool(ctx.taskId, name, input, tool);
            if (gate && !gate.approved) return normalize(gate);
            dayApproved = Boolean(gate && gate.approved);
        }
        if (ctx.chatPolicy && tool.acts === true) {
            if (!ctx.approveChatTool || !await ctx.approveChatTool(name, input)) return normalize({ text: 'The action was not approved. Nothing ran.', isError: true });
        }
        // A rule that asks before a call the approval gate would not see (a read, a step with no approval kind, a chat
        // read): there is nobody to ask here, so it does not run, and the model is told why.
        const gated = !dayApproved && !ctx.chatPolicy && tool.acts === true && typeof ctx.requestApproval === 'function'
            && Boolean(typeof tool.step === 'function' ? tool.step(input) : stepFor(name, input));
        if (rule && rule.decision === 'ask' && !dayApproved && !(ctx.chatPolicy && tool.acts === true) && !gated) {
            if (typeof ctx.requestApproval !== 'function' || ctx.chatPolicy) {
                return normalize({ text: JSON.stringify({ error: `not run: ${rule.why}, and this run has nobody to ask` }), data: { refused: rule.why }, isError: true });
            }
            let ask;
            try {
                ask = await ctx.requestApproval({ kind: 'actor.action', summary: `Use ${name.replace(/_/g, ' ')}`, payload: input, target: name, act: 'act', rule });
            } catch (err) {
                return normalize({ text: JSON.stringify({ error: `the approval gate could not be asked, so nothing ran: ${(err && err.message) || err}`.slice(0, 300) }), isError: true });
            }
            const stopped = gateAnswer(ask);
            if (stopped) return stopped;
        }
        // The approval gate (plan §12 A-2): every acting tool sees levels.decide with its act and its
        // always-ask category before it changes anything. A tool that only writes Actor's own working
        // state says null and goes on. A chat has its own consent card above, so it is not asked twice.
        if (!dayApproved && !ctx.chatPolicy && tool.acts === true && typeof ctx.requestApproval === 'function') {
            // A dynamic tool may know a step the generic mapping cannot (a skill's code: kind skill.run, target
            // "<slug>@<version> <tool>"); a module file says it in agents/actions.js.
            const step = typeof tool.step === 'function' ? tool.step(input) : stepFor(name, input);
            if (step) {
                let ask;
                try {
                    // The step says which kind of act it is (plan HO1); an unknown tool is an action of a connected tool.
                    ask = await ctx.requestApproval({ ...step, kind: step.kind || 'actor.action', rule });
                } catch (err) {
                    return normalize({ text: JSON.stringify({ error: `the approval gate could not be asked, so nothing ran: ${(err && err.message) || err}`.slice(0, 300) }), isError: true });
                }
                const stopped = gateAnswer(ask);
                if (stopped) return stopped;
            }
        }
        const signal = ctx.signal;
        const timeoutMs = Math.min(tool.timeoutMs || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
        const timeout = AbortSignal.timeout(timeoutMs);
        const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
        try {
            const out = await tool.run(input && typeof input === 'object' ? input : {}, { ...ctx, signal: composed, fetch: ctx.fetch || fetchImpl, tool });
            return normalize(out);
        } catch (err) {
            if (signal && signal.aborted) throw err;
            const why = timeout.aborted ? `timed out after ${timeoutMs} ms` : ((err && err.message) || String(err));
            return { text: JSON.stringify({ error: why.slice(0, 300) }), data: null, sources: [], isError: true };
        }
    }

    /**
     * What the approval gate answered, as the step's result: pending (the card is out; an unattended run says it goes on
     * without it), refused (plan HO7, or a rule), or null when the step may run.
     */
    function gateAnswer(ask) {
        if (ask && ask.pending) {
            const why = ask.unattended ? ` This run is unattended (${ask.unattended}), so it goes on without it.` : '';
            return normalize({
                text: JSON.stringify({ error: `not started: the person must approve it first at ${ask.url}.${why}`, approval: { id: ask.id, url: ask.url } }),
                data: ask, isError: true,
            });
        }
        // The gate refused the step outright (plan HO7: a tip over what is left of the agent's weekly allowance, or a
        // creator that names nobody). The step does not run, and the model is told why in one plain line.
        if (ask && ask.refused) {
            return normalize({
                text: JSON.stringify({ error: String(ask.refused).slice(0, 300) }),
                data: { refused: String(ask.refused).slice(0, 300) }, isError: true,
            });
        }
        return null;
    }

    function report() {
        return { count: byName.size, names: [...byName.keys()].sort(), errors };
    }

    return { dir, tools: [...byName.values()], byName, errors, definitions, run, get, has, report, validateTool };
}

/** A tool result as the loop, the ledger and the check use it. */
function normalize(out) {
    const empty = { text: '', data: null, sources: [], artifacts: [], refs: [], isError: false, secret: false };
    if (out == null) return empty;
    if (typeof out === 'string') return { ...empty, text: out };
    if (typeof out !== 'object') return { ...empty, text: String(out) };
    const data = out.data === undefined ? null : out.data;
    let text = typeof out.text === 'string' ? out.text : '';
    if (!text && data != null) text = JSON.stringify(data);
    const sources = Array.isArray(out.sources) ? out.sources.filter((s) => s && typeof s.url === 'string').slice(0, 20) : [];
    const artifacts = Array.isArray(out.artifacts) ? out.artifacts.slice(0, 20) : [];
    // A tool may point at a row the task page can open (stage V2-6: a memory a cited answer leaned on). Only the
    // fields the page renders are kept, so a tool can never smuggle a whole object into a task result.
    const refs = Array.isArray(out.refs) ? out.refs.filter((r) => r && typeof r === 'object' && typeof r.kind === 'string' && typeof r.id === 'string')
        .slice(0, 20).map((r) => ({
            kind: r.kind.slice(0, 32), id: r.id.slice(0, 64), text: String(r.text == null ? '' : r.text).slice(0, 500),
            source: r.source == null ? null : String(r.source).slice(0, 32), source_task: r.source_task == null ? null : String(r.source_task).slice(0, 64),
            agent_id: r.agent_id == null ? null : String(r.agent_id).slice(0, 64),
        })) : [];
    // The park marker (plan A2): a tool that parks the run (wait_for) says so here. The loop stops there, with no
    // model running, until the event or the deadline comes. Only a wait may set it.
    const park = out.park && typeof out.park === 'object' && typeof out.park.wait_id === 'string'
        ? { wait_id: out.park.wait_id.slice(0, 64) } : null;
    return { text, data, sources, artifacts, refs, isError: out.isError === true, secret: out.secret === true, park };
}

module.exports = { createRegistry, validateTool, allowedBy, normalize, SCOPES, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS };
