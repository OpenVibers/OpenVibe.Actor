'use strict';

/**
 * The loop's state as a checkpoint, and back (Actor v2, stage V2-9).
 *
 * A checkpoint has to hold everything the loop needs to continue after a restart: the messages, the evidence ledger,
 * the plan and the brain's two ledgers, the allow-list, the budget spent and the tier. It holds no functions, no
 * signal, no store and no tool module: those are rebuilt from the live process.
 *
 *   snapshot(state, { spent }) → a JSON-safe object
 *   restore(snapshot)           → a state the loop's drive() can continue, or null for an unknown version
 *
 * A tool result the tool marked secret is kept as a redacted item (checkpoints.js strips it before sealing); its
 * evidence id stays, so an answer that cited it still has a coherent ledger. The restored ledger is rebuilt item by
 * item, so ids stay E1, E2, … exactly as they were.
 *
 * This module is pure: no database, no crypto, so a test can round-trip a state.
 */

const { createLedger } = require('./evidence');
const { createProgress } = require('./brain/ledger');
const { createEscalations } = require('./brain/escalate');

const VERSION = 1;
const MAX_MESSAGES = 2000;

const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

function safeMessage(message) {
    if (!message || typeof message !== 'object') return message;
    const out = {};
    for (const key of ['role', 'content', 'tool_call_id', 'name']) {
        if (message[key] !== undefined) out[key] = message[key];
    }
    if (Array.isArray(message.tool_calls)) out.tool_calls = message.tool_calls;
    // A tool result the tool marked secret is stored as the fact that the call happened, never its content: the model
    // needs only that, and a checkpoint must never hold a credential.
    let secret = message.secret === true;
    if (!secret && message.role === 'tool' && typeof message.content === 'string') {
        try { secret = JSON.parse(message.content).secret === true; } catch { secret = false; }
    }
    if (secret) out.content = JSON.stringify({ error: 'the tool marked this result secret; its content was not stored' });
    return out;
}

/** The loop's state as a checkpoint. `spent` is what the task has spent so far (the loop does not know the budget). */
function snapshot(state, { spent = 0, now = () => Date.now() } = {}) {
    if (!state) return null;
    const brain = state.brain || {};
    const progressState = brain.progressLedger && brain.progressLedger.state ? clone(brain.progressLedger.state) : null;
    return {
        v: VERSION,
        saved_at: new Date(now()).toISOString(),
        task: String(state.task || ''),
        mode: state.mode || null,
        tier: state.tier || null,
        baseTier: state.baseTier || state.tier || null,
        model: state.model || null,
        family: state.family || null,
        provider: state.provider || null,
        calls: Number(state.calls) || 0,
        lastText: String(state.lastText || ''),
        answered: state.answered === true,
        stopped: state.stopped || null,
        selfReflections: Number(state.selfReflections) || 0,
        fixedTier: state.fixedTier === true,
        readOutside: state.readOutside === true,
        context: clone(Array.isArray(state.context) ? state.context : []),
        plan: clone(state.plan || { assumptions: [], steps: [] }),
        messages: (() => {
            const all = Array.isArray(state.messages) ? state.messages : [];
            // Keep the system prompt at the head even on a very long run; the newest messages are what continue.
            const kept = all.length > MAX_MESSAGES ? [all[0], ...all.slice(-(MAX_MESSAGES - 1))] : all;
            return kept.map(safeMessage);
        })(),
        ledger: clone(state.ledger && Array.isArray(state.ledger.items) ? state.ledger.items : []),
        counts: state.counts instanceof Map ? [...state.counts.entries()].map(([k, n]) => [String(k), Number(n) || 0]) : [],
        allow: state.allow instanceof Set ? [...state.allow] : (Array.isArray(state.allow) ? state.allow.slice() : null),
        tools: Array.isArray(state.tools) ? state.tools.map((t) => t && t.function && t.function.name).filter(Boolean) : [],
        brain: {
            understanding: clone(brain.understanding || null),
            kind: brain.kind || 'answer',
            personAnswer: brain.personAnswer || null,
            ledger: clone(brain.ledger || null),
            progress: clone(brain.progress || null),
            progressState,
            prior: brain.prior instanceof Map ? [...brain.prior.entries()].map(([k, v]) => [String(k), clone(v)]) : [],
            steps: clone(Array.isArray(brain.steps) ? brain.steps : []),
            tiers: brain.tiers instanceof Set ? [...brain.tiers] : (Array.isArray(brain.tiers) ? brain.tiers.slice() : []),
            tools: brain.tools instanceof Set ? [...brain.tools] : (Array.isArray(brain.tools) ? brain.tools.slice() : []),
            demoted: Array.isArray(brain.demoted) ? brain.demoted.slice() : [],
            triedTiers: Array.isArray(brain.triedTiers) ? brain.triedTiers.slice() : [],
            triedTools: Array.isArray(brain.triedTools) ? brain.triedTools.slice() : [],
            questions: Number(brain.questions) || 0,
            toolRuns: Number(brain.toolRuns) || 0,
            lastTool: brain.lastTool || null,
            lastLine: brain.lastLine || null,
            withheld: brain.withheld || null,
            escalations: brain.escalations && typeof brain.escalations.snapshot === 'function' ? clone(brain.escalations.snapshot()) : null,
        },
        spent: Number(spent) || 0,
    };
}

/** The state a checkpoint describes, ready for drive(); null when the version is not this one. */
function restore(snap) {
    if (!snap || typeof snap !== 'object' || snap.v !== VERSION) return null;
    const b = snap.brain || {};
    const state = {
        task: String(snap.task || ''),
        requester: null,
        taskId: null,
        mode: snap.mode || 'balanced',
        tier: snap.tier || 'smart',
        baseTier: snap.baseTier || snap.tier || 'smart',
        signal: null,
        messages: clone(Array.isArray(snap.messages) ? snap.messages : []),
        lastText: String(snap.lastText || ''),
        answered: snap.answered === true,
        model: snap.model || null,
        family: snap.family || null,
        provider: snap.provider || null,
        calls: Number(snap.calls) || 0,
        ledger: createLedger(),
        plan: clone(snap.plan || { assumptions: [], steps: [] }),
        counts: new Map(Array.isArray(snap.counts) ? snap.counts.map(([k, n]) => [String(k), Number(n) || 0]) : []),
        stopped: snap.stopped || null,
        selfReflections: Number(snap.selfReflections) || 0,
        fixedTier: snap.fixedTier === true,
        readOutside: snap.readOutside === true,
        ctx: null,
        context: clone(Array.isArray(snap.context) ? snap.context : []),
        depth: 0,
        tools: [],
        allow: new Set(Array.isArray(snap.allow) ? snap.allow : []),
        fixedTier: false,
        brain: {
            understanding: clone(b.understanding || null),
            kind: b.kind || 'answer',
            personAnswer: b.personAnswer || null,
            ledger: clone(b.ledger || null),
            progressLedger: createProgress({ nextGoal: b.progressState && b.progressState.nextGoal ? b.progressState.nextGoal : null }),
            progress: clone(b.progress || null),
            prior: new Map(Array.isArray(b.prior) ? b.prior.map(([k, v]) => [String(k), clone(v)]) : []),
            steps: clone(Array.isArray(b.steps) ? b.steps : []),
            tiers: new Set(Array.isArray(b.tiers) ? b.tiers : []),
            tools: new Set(Array.isArray(b.tools) ? b.tools : []),
            demoted: Array.isArray(b.demoted) ? b.demoted.slice() : [],
            triedTiers: Array.isArray(b.triedTiers) ? b.triedTiers.slice() : [],
            triedTools: Array.isArray(b.triedTools) ? b.triedTools.slice() : [],
            questions: Number(b.questions) || 0,
            toolRuns: Number(b.toolRuns) || 0,
            lastTool: b.lastTool || null,
            lastLine: b.lastLine || null,
            withheld: b.withheld || null,
            escalations: createEscalations({
                total: b.escalations && b.escalations.total,
                byStep: b.escalations && b.escalations.byStep,
            }),
            // Where the steps recorded in the outcome table start: a resumed run records only what it does after the
            // checkpoint, not the same outcomes again.
            stepsFrom: Array.isArray(b.steps) ? b.steps.length : 0,
        },
    };
    if (b.progressState) Object.assign(state.brain.progressLedger.state, clone(b.progressState));
    for (const item of Array.isArray(snap.ledger) ? snap.ledger : []) {
        state.ledger.add({
            tool: item && item.tool,
            input: item && item.input,
            text: item && item.text,
            data: item && item.data,
            sources: item && item.sources,
            artifacts: item && item.artifacts,
            refs: item && item.refs,
            secret: item && item.secret === true,
            at: item && item.at,
        });
    }
    return state;
}

module.exports = { snapshot, restore, VERSION, MAX_MESSAGES };
