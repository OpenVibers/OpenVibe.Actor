'use strict';
/**
 * Sub-agent authority (the DeepSeek research rule, enforced): a sub-agent's tools are never wider than its parent's.
 * The child's tools are an intersection, its scope the stricter of the two, its budget at most what remains, and a
 * private task can never hand off to a non-private child.
 */
const assert = require('assert');
const { childContext, narrowTools, assertWithinParent, SCOPE_RANK } = require('../server/runtime/subagent');

const def = (name) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object' } } });
const parent = {
    task: 'parent task', mode: 'balanced', scope: 'public', budgetUsd: 0.50, depth: 0,
    tools: [def('search_web'), def('read_page'), def('list_my_robots')],
};

(async () => {
    const results = [];
    const ok = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { results.push(e); console.log(`  ✗ ${name}\n      ${(e.stack || String(e)).split('\n').slice(0, 6).join('\n      ')}`); } };

    await ok('narrowTools is an intersection: a tool the parent does not hold never appears', () => {
        const held = narrowTools(parent.tools, ['read_page', 'run_tool', 'search_web']);
        assert.deepStrictEqual(held.map((d) => d.function.name), ['search_web', 'read_page']);
        assert.strictEqual(narrowTools(parent.tools, null).length, 3, 'no ask means all of the parent\'s tools, not more');
        assert.deepStrictEqual(narrowTools([], ['anything']), []);
    });

    await ok('a child context takes the stricter scope, the smaller budget and one depth more', () => {
        const child = childContext(parent, { task: 'sub-goal', tools: ['read_page'], budgetUsd: 0.10 });
        assert.deepStrictEqual(child.tools.map((d) => d.function.name), ['read_page']);
        assert.strictEqual(child.scope, 'public');
        assert.strictEqual(child.budgetUsd, 0.10);
        assert.strictEqual(child.depth, 1);
        assert.strictEqual(child.task, 'sub-goal');
        assert.strictEqual(parent.budgetUsd, 0.50, 'the parent is not changed');
        // A child asking for more budget gets the parent's remaining, never more.
        assert.strictEqual(childContext(parent, { budgetUsd: 10 }).budgetUsd, 0.50);
        // A stricter scope is kept: private mode is private-ok whatever the parent's scope was.
        assert.strictEqual(childContext(parent, { mode: 'private' }).scope, 'private-ok');
        assert.ok(SCOPE_RANK['private-ok'] < SCOPE_RANK.person && SCOPE_RANK.person < SCOPE_RANK.public);
    });

    await ok('private mode cannot become non-private, however the child asks', () => {
        const secret = { ...parent, mode: 'private', tools: [def('local_note')] };
        const child = childContext(secret, { mode: 'balanced', tools: ['local_note', 'search_web'] });
        assert.strictEqual(child.mode, 'private');
        assert.deepStrictEqual(child.tools.map((d) => d.function.name), ['local_note']);
        assert.throws(() => assertWithinParent(secret, { ...child, mode: 'balanced' }), /private task cannot hand off/);
    });

    await ok('assertWithinParent throws on wider tools, scope, budget or depth, and passes an honest child', () => {
        const child = childContext(parent, { tools: ['read_page'], budgetUsd: 0.1 });
        assert.strictEqual(assertWithinParent(parent, child), true);
        assert.throws(() => assertWithinParent(parent, { ...child, tools: [def('computer_run')] }), /not held by the parent/);
        assert.throws(() => assertWithinParent({ ...parent, scope: 'person' }, { ...child, scope: 'public' }), /wider than person/);
        assert.throws(() => assertWithinParent(parent, { ...child, budgetUsd: 1 }), /larger than the parent/);
        assert.throws(() => assertWithinParent(parent, { ...child, depth: 2 }), /depth grew by more than one/);
    });

    if (results.length) { console.log(`\n${results.length} failed`); process.exit(1); }
    console.log('\nall passed');
})();
