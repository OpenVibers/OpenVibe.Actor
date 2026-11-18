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

    // And no look at the screen while the key shows (the picture would go to a vision model).
    const screenTool = require('../server/runtime/tools/computer_screen');
    const looked = await screenTool.run({ machine: 'dev_01JAB2C3D4E5F6G7H8J9K0MNPQ', desk: 'private', question: 'what is on the page?' }, ctx);
    assert.ok(looked.isError && /call setup_save_key now/.test(looked.text) && !looked.text.includes(CANARY), 'no screenshot while the key shows');

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

    // 11-14 review: the guard outlives the grant. After the save the key page is still open: reads stay masked and
    // screenshots stay blocked, for this provider's key and any other provider's.
    const after = await browserTool.run({ machine: 'dev_01JAB2C3D4E5F6G7H8J9K0MNPQ', action: 'read' }, ctx);
    assert.ok(!after.text.includes(CANARY) && after.text.includes('[a key: hidden]'), 'after the save, a page read still never shows the key');
    let blocked = await screenTool.run({ machine: 'dev_01JAB2C3D4E5F6G7H8J9K0MNPQ', desk: 'private', question: 'and now?' }, ctx);
    assert.ok(blocked.isError && /A key is on the screen/.test(blocked.text), 'after the save, still no screenshot while it shows');
    const OTHER = 'sk-ant-' + 'Q'.repeat(40);
    page = `Anthropic console: ${OTHER}`;
    const other = await browserTool.run({ machine: 'dev_01JAB2C3D4E5F6G7H8J9K0MNPQ', action: 'read' }, ctx);
    assert.ok(!other.text.includes(OTHER), 'another provider\'s key is hidden too');
    blocked = await screenTool.run({ machine: 'dev_01JAB2C3D4E5F6G7H8J9K0MNPQ', desk: 'private' }, ctx);
    assert.ok(blocked.isError, 'and blocks the screenshot');
    // Fail closed: a page that cannot be read gets no screenshot.
    const readPage = core.pcs.browser;
    core.pcs.browser = async () => { throw new Error('the desk did not answer'); };
    blocked = await screenTool.run({ machine: 'dev_01JAB2C3D4E5F6G7H8J9K0MNPQ', desk: 'private' }, ctx);
    assert.ok(blocked.isError && /could not be read to check it/.test(blocked.text), 'an unreadable page gets no screenshot');
    // 11-15 review: an empty or error-shaped read proves nothing either, and lets no screenshot by.
    for (const answer of [{}, { error: 'no page open' }, { ok: false, text: 'x' }, { text: '   ', url: 'about:blank' }, { isError: true, text: 'boom' }, [], 'text']) {
        core.pcs.browser = async () => answer;
        blocked = await screenTool.run({ machine: 'dev_01JAB2C3D4E5F6G7H8J9K0MNPQ', desk: 'private' }, ctx);
        assert.ok(blocked.isError && /could not be read to check it/.test(blocked.text), `no screenshot on ${JSON.stringify(answer)}`);
    }
    // A key anywhere in the answer counts, not only its text: an element's line or a receipt's new lines.
    core.pcs.browser = async () => ({ text: 'API keys', url: 'https://platform.deepseek.test/api_keys', elements: [`e4 textbox "Key" value "${CANARY}"`], receipt: { appeared: [`Copied ${CANARY}`] } });
    blocked = await screenTool.run({ machine: 'dev_01JAB2C3D4E5F6G7H8J9K0MNPQ', desk: 'private' }, ctx);
    assert.ok(blocked.isError && /A key is on the screen/.test(blocked.text), 'a key in an element blocks the screenshot');
    const deep = await browserTool.run({ machine: 'dev_01JAB2C3D4E5F6G7H8J9K0MNPQ', action: 'read' }, ctx);
    assert.ok(!JSON.stringify(deep).includes(CANARY), 'and is hidden from every part of a page read (elements, receipts)');
    assert.ok(deep.data.elements[0].includes('[a key: hidden]') && deep.data.receipt.appeared[0].includes('[a key: hidden]'), JSON.stringify(deep.data));
    // The person's own screen can show a key in another window: a key setup looks only at its private desk.
    core.pcs.browser = async () => ({ text: 'Nothing secret here', url: 'https://example.test/' });
    blocked = await screenTool.run({ machine: 'dev_01JAB2C3D4E5F6G7H8J9K0MNPQ' }, ctx);
    assert.ok(blocked.isError && /private desk only/.test(blocked.text), 'no screenshot of the person\'s own screen in a key setup');
    core.pcs.browser = readPage;
    // A provider whose keys we cannot recognise: no screenshots at all.
    grants.remember('tsk_six', { grantId: GRANT, keys: ['mystery.api_key'], provider: 'mystery' });
    blocked = await screenTool.run({ machine: 'dev_01JAB2C3D4E5F6G7H8J9K0MNPQ', desk: 'private' }, { ...ctx, taskId: 'tsk_six' });
    assert.ok(blocked.isError && /cannot be recognised/.test(blocked.text), 'an unknown key shape: no screenshots');
    // After the grant's 30 minutes the guard still holds; it ends long after the task.
    const t1 = Date.now();
    grants.remember('tsk_seven', { grantId: GRANT, keys: ['deepseek.api_key'], provider: 'deepseek' }, t1);
    assert.strictEqual(grants.grantFor('tsk_seven', t1 + grants.TTL_MS + 1), null, 'the grant expired');
    assert.ok(grants.guardFor('tsk_seven', t1 + grants.TTL_MS + 1), 'the guard did not');
    assert.strictEqual(grants.guardFor('tsk_seven', t1 + grants.GUARD_MS + 1), null, 'and ends in the end');
    page = `Your new API key (shown once):\n${CANARY}\nDone`;

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
    // 11-15 review: no answer in time is not "not saved" (Network may still finish the write), and the agent says so.
    const slowSaver = grants.createSaver({ config: { networkInternalUrl: 'http://network.test' }, tokens: { authHeaders: async () => ({}) },
        fetchImpl: async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); } });
    assert.deepStrictEqual(await slowSaver.save(GRANT, { 'deepseek.api_key': CANARY }, 'tsk_eight'), { ok: false, reason: 'network_no_answer' });
    grants.remember('tsk_eight', { grantId: GRANT, keys: ['deepseek.api_key'], provider: 'deepseek' });
    const noAnswer = await tool.run({ machine: 'dev_01JAB2C3D4E5F6G7H8J9K0MNPQ' }, { ...ctx, taskId: 'tsk_eight', setupSaver: slowSaver });
    assert.ok(noAnswer.isError && /may still be saving/.test(noAnswer.text) && !noAnswer.text.includes(CANARY), noAnswer.text);
    console.log('setup save key: the page read here, one key by its shape, saved through the grant, never in the answer');
})().catch((e) => { console.error(e); process.exit(1); });
