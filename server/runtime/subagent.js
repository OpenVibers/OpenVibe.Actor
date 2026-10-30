'use strict';

/**
 * Sub-agent authority (groundwork for V2-7, enforced now). A sub-goal that is a task of its own can run as a child
 * loop with a slice of the budget. The DeepSeek research (Attenu head-to-head, 09-2026) found LangGraph and CrewAI
 * handoffs can WIDEN a child's authority; ours cannot, structurally:
 *
 *   - the child's tools are an intersection of the parent's tool definitions (never a union);
 *   - its scope is the stricter of the parent's and its own (private-ok < person < public);
 *   - its budget is at most the parent's remaining budget;
 *   - private mode can never become non-private.
 *
 * childContext(parent, { task, tools, budgetUsd, mode }) and assertWithinParent(parent, child) make the rule explicit;
 * the test suite checks every combination.
 */

const SCOPE_RANK = { 'private-ok': 0, person: 1, public: 2 };
const WORST = (a, b) => (SCOPE_RANK[a] <= SCOPE_RANK[b] ? a : b);

/** The parent's definitions the child may see: all of them, or only the names it asks for (still an intersection). */
function narrowTools(parentTools = [], wanted = null) {
    const parentNames = new Set(parentTools.map((d) => d && d.function && d.function.name).filter(Boolean));
    if (!wanted) return parentTools.slice();
    const allow = new Set(wanted);
    return parentTools.filter((d) => d && d.function && parentNames.has(d.function.name) && allow.has(d.function.name));
}

function childContext(parent = {}, { task, tools = null, budgetUsd = null, mode = null } = {}) {
    const privateParent = parent.mode === 'private' || parent.scope === 'private-ok';
    const childMode = privateParent ? 'private' : (mode || parent.mode || null);
    const childScope = privateParent || mode === 'private' ? 'private-ok' : (parent.scope || 'public');
    const scope = WORST(parent.scope || 'public', childScope);
    return {
        ...parent,
        task: task == null ? parent.task : String(task),
        mode: childMode,
        scope,
        tools: narrowTools(parent.tools || [], tools),
        budgetUsd: Math.min(Number.isFinite(parent.budgetUsd) ? parent.budgetUsd : Infinity, Number.isFinite(budgetUsd) ? budgetUsd : Infinity),
        depth: (parent.depth || 0) + 1,
    };
}

/** Throws when a child would have more authority than its parent (the test's rule, callable at runtime). */
function assertWithinParent(parent = {}, child = {}) {
    const parentNames = new Set((parent.tools || []).map((d) => d && d.function && d.function.name).filter(Boolean));
    const wider = (child.tools || []).map((d) => d && d.function && d.function.name).filter((n) => n && !parentNames.has(n));
    if (wider.length) throw new Error(`sub-agent tool(s) not held by the parent: ${wider.join(', ')}`);
    if ((SCOPE_RANK[child.scope] || 0) > (SCOPE_RANK[parent.scope] || 0)) throw new Error(`sub-agent scope ${child.scope} is wider than ${parent.scope}`);
    if (parent.mode === 'private' && child.mode !== 'private') throw new Error('a private task cannot hand off to a non-private sub-agent');
    if (Number.isFinite(child.budgetUsd) && Number.isFinite(parent.budgetUsd) && child.budgetUsd > parent.budgetUsd) throw new Error('sub-agent budget is larger than the parent\'s');
    if ((child.depth || 0) > (parent.depth || 0) + 1) throw new Error('sub-agent depth grew by more than one');
    return true;
}

module.exports = { childContext, narrowTools, assertWithinParent, SCOPE_RANK };
