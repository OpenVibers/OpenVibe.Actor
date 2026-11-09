'use strict';
const assert = require('assert');
const { boot, done } = require('./helpers/boot');
(async () => {
    const t = await boot();
    try {
        const user = t.network.addUser('dock');
        const path = '/api/v1/me/actor';
        const headers = { origin: 'https://openvibe.blog' };
        const bearer = t.network.dockToken(user, 'actor.me.read');
        const read = await t.get(path, { bearer, headers });
        assert.equal(read.status, 200, read.text);
        assert.equal(read.json().owner, 'user:' + user.subject);
        assert.equal(read.headers.get('access-control-allow-origin'), headers.origin);
        assert.equal(read.headers.get('access-control-allow-credentials'), null);
        assert.equal((await t.get(path, { bearer: t.network.dockToken(user, 'dock'), headers })).status, 403);
        assert.equal((await t.get(path + '/pause', { bearer, headers, json: {} })).status, 403);
        assert.equal((await t.get(path + '/pause', { bearer: t.network.dockToken(user, 'actor.me.write'), headers, json: {} })).status, 200);
        assert.equal((await t.get('/api/v1/tasks', { bearer })).status, 403);
        assert.equal((await t.get(path, { bearer, headers: { origin: 'https://evil.example' } })).status, 403);
        assert.equal((await t.get(path, { as: user, headers })).status, 401);
        assert.equal((await t.get(path, { method: 'OPTIONS', headers: { ...headers, 'access-control-request-method': 'PATCH' } })).status, 204);
        for (const extra of [{ client_id: 'other' }, { role: 'admin' }, { fam: '' }]) assert.equal((await t.get(path, { bearer: t.network.dockToken(user, 'actor.me.read', extra), headers })).status, 401);
    } finally { await t.close(); }
})().then(() => done(), done);
