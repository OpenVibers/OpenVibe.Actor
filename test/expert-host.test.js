'use strict';
/**
 * openvibe.expert from Actor (plan §D item 6): with the expert client's secret, a request for openvibe.expert gets the
 * gallery at /, an Expert at /<bp_id>, its own sign-in (Network's `expert` client, openvibe.expert's callback), and
 * openvibe.actor for everything that lives there; openvibe.actor is unchanged. Without the secret, nothing changes.
 */
const assert = require('node:assert/strict');
const { boot, check, done } = require('./helpers/boot');

const EXPERT = { host: 'openvibe.expert', 'x-forwarded-host': 'openvibe.expert' };   // fetch drops Host; nginx sends both

(async () => {
    const t = await boot({ env: { EXPERT_OAUTH_CLIENT_SECRET: 'expert-secret' } });
    const off = await boot();
    try {
        await check('openvibe.expert/ is the gallery; openvibe.actor/ is still Actor', async () => {
            const gallery = await t.get('/', { headers: EXPERT });
            assert.equal(gallery.status, 200, gallery.text.slice(0, 200));
            assert.match(gallery.text, /Agents with a personality and a job/);
            const actorHome = await t.get('/');
            assert.doesNotMatch(actorHome.text, /Agents with a personality and a job/, 'Actor\'s own home is not the gallery');
            const www = await t.get('/', { headers: { host: 'www.openvibe.expert', 'x-forwarded-host': 'www.openvibe.expert' } });
            assert.match(www.text, /Agents with a personality and a job/, 'www. is the same site');
        });

        await check('an Expert and the make pages at short addresses; Actor-only pages go to openvibe.actor', async () => {
            const list = await t.get('/experts', { headers: EXPERT });
            const id = (/href="\/experts\/(bp_[a-z0-9_]+)"/.exec(list.text) || [])[1];
            if (id) {
                const one = await t.get(`/${id}`, { headers: EXPERT });
                assert.equal(one.status, 200, `/${id}`);
                assert.equal((await t.get(`/experts/${id}`, { headers: EXPERT })).status, 200, 'the pages\' own links work too');
            }
            const make = await t.get('/new', { headers: EXPERT });
            assert.ok([200, 302, 303].includes(make.status), `/new answers (${make.status})`);
            const away = await t.get('/tasks?x=1', { headers: EXPERT });
            assert.equal(away.status, 302);
            assert.equal(away.headers.get('location'), 'https://openvibe.actor/tasks?x=1');
        });

        await check('signing in on openvibe.expert uses its own client and callback', async () => {
            const login = await t.get('/auth/login?next=%2F', { headers: EXPERT });
            assert.ok([302, 303].includes(login.status), `login redirects (${login.status})`);
            const to = new URL(login.headers.get('location'));
            assert.equal(to.searchParams.get('client_id'), 'expert');
            assert.equal(to.searchParams.get('redirect_uri'), 'https://openvibe.expert/auth/callback');
            const actorLogin = new URL((await t.get('/auth/login?next=%2F')).headers.get('location'));
            assert.equal(actorLogin.searchParams.get('client_id'), 'actor', 'openvibe.actor keeps its own');
        });

        await check('without the expert secret nothing changes: openvibe.expert/ is not rewritten', async () => {
            const r = await off.get('/', { headers: EXPERT });
            assert.doesNotMatch(r.text, /Agents with a personality and a job/);
            assert.equal(new URL((await off.get('/auth/login?next=%2F', { headers: EXPERT })).headers.get('location')).searchParams.get('client_id'), 'actor');
        });
    } finally {
        await t.close();
        await off.close();
    }
    done();
})();
