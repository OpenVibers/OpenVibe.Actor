'use strict';
// Setup done by your agent (plan §AB.44): the task's grant lives in memory beside its task for at most 30 minutes; the
// tool setup_save_key reads the provider page itself, finds the one new key by the provider's shape and saves it through
// the grant; the model's answer carries "saved" and four characters, never the key (a canary key appears nowhere but the
// save); no key, two keys, an unknown provider or no grant each say so; a spent grant is forgotten.
const assert = require('assert');
const grants = require('../server/setup/grants');
const tool = require('../server/runtime/tools/setup_save_key');
const { serviceFor } = require('../server/runtime/tools/_openvibe');

const CANARY = 'sk-' + 'c4a7'.repeat(8);   // a DeepSeek-shaped key, 32 hex
const GRANT = 'sgr_' + 'A'.repeat(32);
const ME = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
(async () => {
    // The key on a page.
    assert.deepStrictEqual(grants.findKey(`Your new key\n${CANARY}\nCopy`, 'deepseek'), { key: CANARY });
    assert.deepStrictEqual(grants.findKey('Create a key to start', 'deepseek'), { reason: 'no_key_on_page' });
    assert.deepStrictEqual(grants.findKey(`${CANARY} and sk-${'b'.repeat(32)}`, 'deepseek'), { reason: 'several_keys_on_page' });
    assert.deepStrictEqual(grants.findKey(CANARY, 'nobody'), { reason: 'unknown_provider' });
    assert.deepStrictEqual(grants.findKey('sk-or-v1-' + 'a'.repeat(64), 'openrouter'), { key: 'sk-or-v1-' + 'a'.repeat(64) });

    // The grant beside its task, for 30 minutes at most.
    const t0 = Date.now();
    grants.remember('tsk_one', { grantId: GRANT, keys: ['deepseek.api_key'], provider: 'deepseek', label: 'DeepSeek' }, t0);
    assert.ok(grants.grantFor('tsk_one', t0 + 1000), 'live');
    assert.strictEqual(grants.grantFor('tsk_one', t0 + grants.TTL_MS + 1), null, 'gone after 30 minutes');
    assert.throws(() => grants.remember('tsk_two', { grantId: 'nope', keys: ['k'] }), /grant id/);

    // The tool, on a task with a live grant.
    const config = { networkInternalUrl: 'http://network.test', services: {}, oauth: { clientId: 'actor', clientSecret: '' } };
    const core = serviceFor({ config });
    let page = `Your new API key (shown once):\n${CANARY}\nDone`;
    core.pcs.enabled = true;
    core.pcs.browser = async (person, machine, a) => { assert.strictEqual(a.action, 'read'); return { text: page, url: 'https://platform.deepseek.test/api_keys' }; };
    const saves = [];
    const setupSaver = { save: async (grantId, values, run) => { saves.push({ grantId, values, run }); return { ok: true, keys: [{ key: 'deepseek.api_key', hint: '…c4a7' }] }; } };
    const ctx = { config, taskId: 'tsk_three', requester: `user:${ME}`, setupSaver, state: {} };
    assert.strictEqual(tool.available(ctx), false, 'no grant: not offered');
    grants.remember('tsk_three', { grantId: GRANT, keys: ['deepseek.api_key'], provider: 'deepseek', label: 'DeepSeek' });
    assert.strictEqual(tool.available(ctx), true, 'a task with a live grant has it');

    // While the grant is live, the agent's own page reads hide the key.
    const browserTool = require('../server/runtime/tools/computer_browser');
    const read = await browserTool.run({ machine: 'dev_01JAB2C3D4E5F6G7H8J9K0MNPQ', action: 'read' }, ctx);
    assert.ok(!read.text.includes(CANARY) && read.text.includes('[the new key: call setup_save_key]'), 'a page read never shows the key');

    page = 'Create new API key';
    let out = await tool.run({ machine: 'dev_01JAB2C3D4E5F6G7H8J9K0MNPQ' }, ctx);
    assert.match(JSON.parse(out.text).reason, /does not show a new key yet/);
    assert.strictEqual(saves.length, 0, 'nothing saved without a key');

    page = `Your new API key (shown once):\n${CANARY}\nDone`;
    out = await tool.run({ machine: 'dev_01JAB2C3D4E5F6G7H8J9K0MNPQ' }, ctx);
    assert.deepStrictEqual(JSON.parse(out.text), { ok: true, saved: 'DeepSeek key', ends_in: '…c4a7' }, 'saved, in words and four characters');
    assert.deepStrictEqual(saves, [{ grantId: GRANT, values: { 'deepseek.api_key': CANARY }, run: 'tsk_three' }], 'the key went to the save, under the grant\'s key');
    assert.ok(!JSON.stringify(out).includes(CANARY), 'the answer never carries the key');
    assert.strictEqual(grants.grantFor('tsk_three'), null, 'a spent grant is forgotten');
    assert.strictEqual(tool.available(ctx), false, 'and the tool is gone');

    // A save Network refuses says why, never the key.
    grants.remember('tsk_four', { grantId: GRANT, keys: ['deepseek.api_key'], provider: 'deepseek' });
    const refused = await tool.run({ machine: 'dev_01JAB2C3D4E5F6G7H8J9K0MNPQ' }, { ...ctx, taskId: 'tsk_four', setupSaver: { save: async () => ({ ok: false, reason: 'setup_grant.gone' }) } });
    assert.ok(refused.isError && /setup_grant\.gone/.test(refused.text) && !refused.text.includes(CANARY));

    // The real saver: Network's route, Actor's token, the values and nothing back.
    const seen = [];
    const saver = grants.createSaver({ config: { networkInternalUrl: 'http://network.test' }, tokens: { authHeaders: async () => ({ Authorization: 'Bearer svc' }) },
        fetchImpl: async (url, init) => { seen.push({ url, init }); return new Response(JSON.stringify({ saved: true, service: 'ai', namespace: 'ai.providers', keys: [{ key: 'deepseek.api_key', hint: '…c4a7' }] }), { status: 200 }); } });
    const r = await saver.save(GRANT, { 'deepseek.api_key': CANARY }, 'tsk_five');
    assert.deepStrictEqual(r, { ok: true, keys: [{ key: 'deepseek.api_key', hint: '…c4a7' }] });
    assert.strictEqual(seen[0].url, `http://network.test/internal/setup/grants/${GRANT}/save`);
    assert.strictEqual(seen[0].init.headers.Authorization, 'Bearer svc');
    assert.strictEqual(seen[0].init.redirect, 'error');
    assert.deepStrictEqual(JSON.parse(seen[0].init.body), { values: { 'deepseek.api_key': CANARY }, run: 'tsk_five' });
    assert.deepStrictEqual(await saver.save('bad', {}, null), { ok: false, reason: 'no_grant' });
    console.log('setup save key: the page read here, one key by its shape, saved through the grant, never in the answer');
})().catch((e) => { console.error(e); process.exit(1); });
