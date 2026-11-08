'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const contacts = require('../server/agents/contacts');
const mention = require('../server/triggers/mention');
const contracts = require('openvibe-contracts');

const SAME = { 'sec-fetch-site': 'same-origin' };

(async () => {
    await check('Unicode, case, and word boundaries are respected', async () => {
        assert.ok(mention.matches('The ＲＥＬＥＡＳＥ is ready', { phrases: ['release'], match: 'any' }));
        assert.ok(mention.matches('ReLeAsE and rollback', { phrases: ['release', 'rollback'], match: 'all' }));
        assert.ok(!mention.matches('preRelease notes', { phrases: ['release'], match: 'any' }));
        assert.ok(!mention.matches('releases', { phrases: ['release'], match: 'any' }));
        assert.ok(!mention.matches('release only', { phrases: ['release', 'rollback'], match: 'all' }));
    });

    const t = await boot({ loop: { close: async () => {}, run: async () => ({ text: 'The release is ready.', sources: [], evidence: [], model: 'fake' }) } });
    try {
        const ada = t.network.addUser('ada');
        const bo = t.network.addUser('bo');
        const s = t.ctx.s;
        const vibe = await contacts.ensureVibe(s, t.config, `user:${ada.subject}`);
        const as = (person, method, path, options = {}) => t.get(path, { as: person, method, headers: SAME, ...options });
        const turn = async (person, text, parent = null) => {
            const made = await as(person, 'POST', '/chat', { form: { task: text, ...(parent ? { parent } : {}) } });
            assert.strictEqual(made.status, 303, made.text);
            const id = made.headers.get('location').match(/tsk_[0-9A-HJKMNP-TV-Z]{26}/)[0];
            await t.waitFor(id);
            return id;
        };

        const first = await turn(ada, 'Please help with planning.');
        let id;
        await check('the API validates mention shape and creates a watchless card', async () => {
            const bad = await as(ada, 'POST', '/api/v1/triggers', { json: { agent_id: vibe.id, task: 'Check rollback', kind: 'mention', mention: { phrases: ['r'], match: 'any' } } });
            assert.strictEqual(bad.status, 422, bad.text);
            const made = await as(ada, 'POST', '/api/v1/triggers', { json: {
                agent_id: vibe.id, task: 'Remind me to check rollback', kind: 'mention',
                mention: { phrases: ['release'], match: 'any' }, words: 'When you mention the release',
                turn_task_id: first,
            } });
            assert.strictEqual(made.status, 201, made.text);
            const card = made.json().trigger;
            id = card.id;
            assert.deepStrictEqual(contracts.validate('actor.trigger@1', card).errors, []);
            assert.strictEqual(card.when.mention.phrases[0], 'release');
            assert.strictEqual(card.fires, 'once_per_conversation');
            assert.ok(card.expires_at);
            assert.strictEqual(card.watch, null);
            const page = await as(ada, 'GET', `/chat/turn/${first}`);
            assert.match(page.text, /Waiting for: release/);
            assert.ok(!page.text.includes('value="run"'), 'a mention cannot be run without a message');
        });

        await check('only the owner message starts one routine run per conversation and posts under that message', async () => {
            await turn(bo, 'The release is ready.');
            const before = Number(await s.db.value('SELECT count(*) FROM actor_mention_firings WHERE trigger_id = $1', [id]));
            assert.strictEqual(before, 0);
            const unrelated = await turn(ada, 'The prerelease checklist is ready.', first);
            assert.strictEqual(Number(await s.db.value('SELECT count(*) FROM actor_mention_firings WHERE trigger_id = $1', [id])), 0);
            const fired = await turn(ada, 'The RELEASE is ready.', unrelated);
            const firing = await s.db.maybe('SELECT * FROM actor_mention_firings WHERE trigger_id = $1', [id]);
            assert.strictEqual(firing.conversation, `chat:${first}`);
            assert.strictEqual(firing.turn_task_id, fired);
            assert.ok(firing.task_id);
            await t.waitFor(firing.task_id);
            const page = await as(ada, 'GET', `/chat/turn/${fired}`);
            assert.match(page.text, /Waiting for: release/);
            assert.match(page.text, /open the run/);
            await turn(ada, 'Release again.', fired);
            assert.strictEqual(Number(await s.db.value('SELECT count(*) FROM actor_mention_firings WHERE trigger_id = $1', [id])), 1);
            const newThread = await turn(ada, 'Release again in a new conversation.');
            assert.ok(newThread);
            assert.strictEqual(Number(await s.db.value('SELECT count(*) FROM actor_mention_firings WHERE trigger_id = $1', [id])), 2);
        });

        await check('expiry and cap validation reject unsafe requests', async () => {
            const expired = await as(ada, 'POST', '/api/v1/triggers', { json: {
                agent_id: vibe.id, task: 'Check rollback', kind: 'mention', mention: { phrases: ['release'], match: 'any' },
                expires_at: new Date(Date.now() + 91 * mention.DAY).toISOString(),
            } });
            assert.strictEqual(expired.status, 422, expired.text);
            const six = await as(ada, 'POST', '/api/v1/triggers', { json: {
                agent_id: vibe.id, task: 'Check rollback', kind: 'mention', mention: { phrases: ['one', 'two', 'three', 'four', 'five', 'six'], match: 'any' },
            } });
            assert.strictEqual(six.status, 422, six.text);
            for (let i = 0; i < 19; i++) {
                const made = await t.ctx.triggers.create({ owner: ada.subject, agentId: vibe.id, task: `Reminder ${i}`, kind: 'mention',
                    mention: { phrases: [`release ${i}`], match: 'any' } });
                assert.ok(made.trigger, JSON.stringify(made.error));
            }
            const over = await t.ctx.triggers.create({ owner: ada.subject, agentId: vibe.id, task: 'One too many', kind: 'mention',
                mention: { phrases: ['too many'], match: 'any' } });
            assert.strictEqual(over.error.code, 'actor.trigger.limit');
        });
    } finally { await t.close(); }
    done();
})().catch((err) => { console.error(err); process.exitCode = 1; });
