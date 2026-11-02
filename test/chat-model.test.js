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
        await check('the chip says Auto by default, and its menu offers OpenVibe\'s and each provider\'s own key', async () => {
            const page = await t.get('/chat', { as: kim });
            assert.strictEqual(page.status, 200);
            assert.match(page.text, /<details class="cc-model" data-cc-model>/);
            assert.match(page.text, /<span data-ccm-label>Auto<\/span>/);
            assert.match(page.text, /data-ccm-choice="auto" aria-pressed="true"/);
            ['openai', 'anthropic', 'deepseek', 'google', 'openrouter', 'mistral'].forEach((p) => {
                assert.ok(page.text.includes(`data-ccm-choice="own:${p}" aria-pressed="false"`), p);
                assert.ok(page.text.includes(`https://ai.openvibe.services/you?allow=actor&amp;provider=${p}`), `${p}: set up at OpenVibe.AI`);
            });
            assert.ok(page.text.includes('href="/chat/model"'), 'the plain form, for no script');
        });

        await check('a tap saves through the API from the page; the chip says the person\'s own key after', async () => {
            const put = await t.get('/api/v1/me/model', { as: kim, method: 'PUT', json: { choice: 'own:openai' }, headers: SAME });
            assert.strictEqual(put.status, 200, put.text);
            assert.strictEqual(put.json().provider, 'openai');
            const page = await t.get('/chat', { as: kim });
            assert.match(page.text, /<span data-ccm-label>Your OpenAI key<\/span>/);
            assert.match(page.text, /data-ccm-choice="own:openai" aria-pressed="true"/);
            assert.match((await t.get('/chat', { as: bo })).text, /<span data-ccm-label>Auto<\/span>/, 'another person\'s choice is theirs');
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
        });

        await check('the script: the menu asks which keys are ready, saves in one request, closes on Escape', async () => {
            const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat.js'), 'utf8');
            assert.match(js, /fetch\('\/api\/v1\/me\/model', \{ credentials: 'same-origin'/);
            assert.match(js, /fetch\('\/api\/v1\/me\/model', \{ method: 'PUT', credentials: 'same-origin'/);
            assert.match(js, /e\.key === 'Escape' && box\.open/);
            assert.match(js, /allow it at OpenVibe\.AI/, 'chosen but not allowed: it says what is left to do');
        });
    } finally {
        await done(t);
    }
})();
