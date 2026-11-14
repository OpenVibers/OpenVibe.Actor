'use strict';
// The face on a notification (plan §AB.31, "Actor rows show the agent's face"): the agent a task belongs to, as Network
// draws it (server/notify/agent-card.js). A person's task with no agent of its own is their Vibe.
const assert = require('assert');
const { cardForTask } = require('../server/notify/agent-card');
const { check, done } = require('./helpers/boot');

const OWNER = 'user:usr_01M4W5JBFEG3QG9ER8W1A2K0RX';
const AGENT = 'agt_01M4W5JBFEG3QG9ER8W1A2K0RX';

// A store that answers the two reads the card makes: the agent of the task, then the person's Vibe.
function storeOf({ byId = {}, vibe = null } = {}) {
    return { db: { maybe: async (sql, args) => {
        if (/FROM actor_agents WHERE id/.test(sql)) return byId[args[0]] || null;
        if (/is_vibe/.test(sql)) return vibe;
        return null;
    } } };
}

(async () => {
    await check('a task wears the face of its own agent', async () => {
        const s = storeOf({ byId: { [AGENT]: { id: AGENT, owner: OWNER, name: 'Researcher', face: 'preset:researcher' } } });
        const card = await cardForTask(s, { requester: OWNER, agent_id: AGENT });
        assert.deepStrictEqual(card, { id: AGENT, name: 'Researcher', glyph: 'search', hue: 205 });
    });

    await check('a task that came through an agent wears that agent\'s face', async () => {
        const s = storeOf({ byId: { [AGENT]: { id: AGENT, owner: OWNER, name: 'Inbox', face: 'preset:inbox' } } });
        const card = await cardForTask(s, { requester: OWNER, via: `agent:${AGENT}` });
        assert.deepStrictEqual(card, { id: AGENT, name: 'Inbox', glyph: 'inbox', hue: 152 });
    });

    await check('a picture is a face, but only an https one', async () => {
        const s = storeOf({ byId: { [AGENT]: { id: AGENT, owner: OWNER, name: 'Helper', face: 'https://openvibe.media/a.png' } } });
        const card = await cardForTask(s, { requester: OWNER, agent_id: AGENT });
        assert.deepStrictEqual(card, { id: AGENT, name: 'Helper', avatar_url: 'https://openvibe.media/a.png', glyph: 'user', hue: card.hue });
        assert.ok(Number.isInteger(card.hue) && card.hue >= 0 && card.hue <= 359, 'a hue between 0 and 359');
        const plain = storeOf({ byId: { [AGENT]: { id: AGENT, owner: OWNER, name: 'Helper', face: 'http://openvibe.media/a.png' } } });
        const noPic = await cardForTask(plain, { requester: OWNER, agent_id: AGENT });
        assert.strictEqual(noPic.avatar_url, undefined, 'a picture that is not https is left out');
    });

    await check('a person\'s task with no agent of its own is their Vibe', async () => {
        const s = storeOf({ vibe: { id: 'agt_01M4W5JBFEG3QG9ER8W1A2K0RY', owner: OWNER, name: 'Vibe', face: 'preset:vibe', is_vibe: true } });
        const card = await cardForTask(s, { requester: OWNER });
        assert.deepStrictEqual(card, { id: 'vibe', name: 'Vibe', glyph: 'spark', hue: 258 });
    });

    await check('a Vibe without a row yet is still a Vibe, without a face', async () => {
        const card = await cardForTask(storeOf(), { requester: OWNER });
        assert.deepStrictEqual(card, { id: 'vibe', name: 'Vibe' });
    });

    await check('a task that is nobody\'s has no agent to wear', async () => {
        assert.strictEqual(await cardForTask(storeOf(), { requester: 'svc:actor' }), null);
        assert.strictEqual(await cardForTask(storeOf(), null), null);
    });
    done();
})();
