'use strict';
/**
 * A signed-in person's home on openvibe.actor is the messenger (the owner, 11-15: the agents, the conversations and
 * one box move to Actor; Codes gets a harness layout): `/` draws the page /chat draws, with the network's messenger
 * (public/js/messenger.js) and private caching. A visitor gets the product's own page, and ?home=1 shows it to a
 * signed-in person too; ?ask= fills the box.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const u = t.network.addUser('homey');

    await check('signed in, / is the messenger: the chat page, its messenger script, never cached in public', async () => {
        const home = await t.get('/', { as: u });
        assert.strictEqual(home.status, 200);
        assert.match(home.text, /data-chat=""/, 'the new-chat page');
        assert.match(home.text, /js\/messenger(\.[0-9a-f]+)?\.js/, 'the messenger takes over');
        const cc = home.headers && typeof home.headers.get === 'function' ? home.headers.get('cache-control') : (home.headers || {})['cache-control'];
        assert.match(String(cc || ''), /private/);
        const asked = await t.get('/?ask=Find%20me%20a%20desk', { as: u });
        assert.match(asked.text, /Find me a desk/, '?ask= fills the box');
    });

    await check('a visitor, and ?home=1, get the product\'s own page', async () => {
        const visitor = await t.get('/');
        assert.strictEqual(visitor.status, 200);
        assert.doesNotMatch(visitor.text, /data-chat=""/);
        const own = await t.get('/?home=1', { as: u });
        assert.strictEqual(own.status, 200);
        assert.doesNotMatch(own.text, /data-chat=""/);
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
