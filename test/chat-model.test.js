'use strict';
// The model chip (plan L55 C3; the owner, 11-01: "use your own API keys, or OpenVibe's"): the chat's composer says
// what this person's tasks run on and changes it in one tap; /chat/model is the same as a plain form. The key itself
// never reaches Actor: the menu links to OpenVibe.AI to add it and allow Actor.
//   node test/chat-model.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');

const SAME = { 'sec-fetch-site': 'same-origin' };

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const bo = t.network.addUser('bo');
    try {
        await check('the model control is in Settings now, not a chip under the composer', async () => {
            const page = await t.get('/chat', { as: kim });
            assert.strictEqual(page.status, 200);
            assert.ok(!/data-cc-model/.test(page.text), 'no model chip on the chat');
            const settings = await t.get('/chat/settings', { as: kim });
            assert.match(settings.text, /href="\/chat\/model"/, 'Settings links the model form');
            const model = await t.get('/chat/model', { as: kim });
            assert.match(model.text, /<input type="radio" name="choice" value="auto" checked>/);
            ['openai', 'anthropic', 'deepseek', 'google', 'openrouter', 'mistral'].forEach((p) => {
                assert.ok(model.text.includes(`value="own:${p}"`), p);
                assert.ok(model.text.includes(`https://ai.openvibe.services/you?allow=actor&amp;provider=${p}`), `${p}: set up at OpenVibe.AI`);
            });
            assert.ok(model.text.includes('value="own:link"'), 'their own computer');
            assert.ok(model.text.includes('https://ai.openvibe.services/you?allow=actor&amp;provider=link'));
        });

        await check('the API saves the choice; the model form shows it, and another person keeps Auto', async () => {
            const put = await t.get('/api/v1/me/model', { as: kim, method: 'PUT', json: { choice: 'own:openai' }, headers: SAME });
            assert.strictEqual(put.status, 200, put.text);
            assert.strictEqual(put.json().provider, 'openai');
            const page = await t.get('/chat/model', { as: kim });
            assert.match(page.text, /<input type="radio" name="choice" value="own:openai" checked>/);
            assert.match((await t.get('/chat/model', { as: bo })).text, /<input type="radio" name="choice" value="auto" checked>/, 'another person\'s choice is theirs');
            assert.strictEqual((await t.get('/api/v1/me/model', { as: kim, method: 'PUT', json: { choice: 'own:nope' }, headers: SAME })).status, 422);
        });

        await check('/chat/model: the plain form saves from openvibe.actor only, and says so', async () => {
            const page = await t.get('/chat/model', { as: kim });
            assert.strictEqual(page.status, 200);
            assert.match(page.text, /<input type="radio" name="choice" value="own:openai" checked>/);
            const saved = await t.get('/chat/model', { as: kim, form: { choice: 'own:anthropic', model: 'claude-sonnet-4-5' }, headers: SAME });
            assert.strictEqual(saved.status, 303);
            assert.strictEqual(saved.headers.get('location'), '/chat/model?saved=1');
            const after = await t.get('/chat/model?saved=1', { as: kim });
            assert.match(after.text, /Saved\. Your next task runs on Your Anthropic key\./);
            assert.match(after.text, /name="model" value="claude-sonnet-4-5"/);
            assert.strictEqual((await t.get('/chat/model', { as: kim, form: { choice: 'auto' }, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
            const bad = await t.get('/chat/model', { as: kim, form: { choice: 'own:openai', model: 'bad model!' }, headers: SAME });
            assert.match(bad.headers.get('location'), /\/chat\/model\?error=/);
            assert.strictEqual((await t.get('/chat/model')).status, 303, 'signed out: sign in first');
            const pc = await t.get('/chat/model', { as: kim, form: { choice: 'own:link' }, headers: SAME });
            assert.strictEqual(pc.status, 303);
            const pcPage = await t.get('/chat/model?saved=1', { as: kim });
            assert.match(pcPage.text, /Saved\. Your next task runs on Your computer\./);
            assert.match(pcPage.text, /<input type="radio" name="choice" value="own:link" checked>/);
            assert.match((await t.get('/chat/model?saved=1', { as: kim })).text, /<input type="radio" name="choice" value="own:link" checked>/);
        });

        await check('the chat no longer mounts a model control; the model page keeps the API', async () => {
            const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat.js'), 'utf8');
            assert.ok(!/data-cc-model|modelChip/.test(js), 'no model chip in the chat script');
            assert.match(js, /data-cc-composer/, 'the chat script mounts composer v2');
            assert.strictEqual((await t.get('/api/v1/me/model', { as: kim })).status, 200, 'the model API is still there');
        });
    } finally {
        await done(t);
    }
})();
