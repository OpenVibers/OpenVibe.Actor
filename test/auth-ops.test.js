'use strict';
/**
 * Sign-in with PKCE S256 through openvibe-sdk/sso (0.73.0): the routes, the SDK's own recovery (a lost flow or a
 * code the Network no longer accepts starts the sign-in once more by itself, and only then shows a page with
 * "Try again"), the old cookies read as the session, truthful readiness (db and the agents are required), 
 * /release.json, loopback-only /metrics, and pages useful without JavaScript.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, check, done } = require('./helpers/boot');

const cookieJar = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

(async () => {
    const t = await boot();
    const user = t.network.addUser('kim');

    await check('login redirects to Network with state and an S256 code challenge', async () => {
        const r = await t.get('/auth/login?next=/tasks');
        assert.strictEqual(r.status, 302);
        const loc = new URL(r.headers.get('location'));
        assert.strictEqual(loc.origin + loc.pathname, `${t.network.url}/oauth/authorize`);
        assert.strictEqual(loc.searchParams.get('client_id'), 'actor');
        assert.strictEqual(loc.searchParams.get('code_challenge_method'), 'S256');
        assert.match(loc.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
        assert.match(loc.searchParams.get('state'), /^[A-Za-z0-9_-]{32}$/);
        assert.match(r.headers.get('set-cookie'), /ov_oauth_state=.*Path=\/auth.*HttpOnly/i);
    });

    await check('login passes ?silent, ?prompt and ?login_hint to the Network', async () => {
        const silent = new URL((await t.get('/auth/login?silent=1')).headers.get('location'));
        assert.strictEqual(silent.searchParams.get('prompt'), 'none');
        const chooser = new URL((await t.get('/auth/login?prompt=select_account')).headers.get('location'));
        assert.strictEqual(chooser.searchParams.get('prompt'), 'select_account');
        const hint = new URL((await t.get('/auth/login?login_hint=kim')).headers.get('location'));
        assert.strictEqual(hint.searchParams.get('login_hint'), 'kim');
    });

    await check('callback exchanges the code with the matching verifier and sets the SDK\'s own httpOnly cookies', async () => {
        const login = await t.get('/auth/login?next=/tasks');
        const loc = new URL(login.headers.get('location'));
        const flowCookie = cookieJar(login);
        const code = t.network.issueCode(user, loc.searchParams.get('code_challenge'));
        const r = await t.get(`/auth/callback?code=${code}&state=${loc.searchParams.get('state')}`, { cookie: flowCookie });
        assert.strictEqual(r.status, 302, r.text);
        assert.strictEqual(r.headers.get('location'), '/tasks');
        const set = r.headers.get('set-cookie');
        assert.match(set, /ov_token=[^;]+;.*HttpOnly/i);
        assert.match(set, /ov_refresh=[^;]+;.*HttpOnly/i);
        assert.match(set, /actor_at=;/);
        const at = set.match(/ov_token=([^;]+)/)[1];
        const me = await t.get('/auth/me', { cookie: `ov_token=${at}` });
        assert.strictEqual(me.json().user.username, 'kim');
        assert.ok(!me.text.includes(at), '/auth/me never returns the token');
    });

    await check('the old cookie is still the session, so nobody is signed out by the move', async () => {
        const at = t.network.userToken(user);
        const me = await t.get('/auth/me', { cookie: `actor_at=${at}` });
        assert.strictEqual(me.status, 200);
        assert.strictEqual(me.json().user.username, 'kim');
        assert.strictEqual(me.json().user.subject_id, user.subject);
    });

    await check('a wrong state or a verifier that does not match starts the sign-in once more', async () => {
        const login = await t.get('/auth/login');
        const loc = new URL(login.headers.get('location'));
        const flowCookie = cookieJar(login);
        const code = t.network.issueCode(user, loc.searchParams.get('code_challenge'));
        const bad = await t.get(`/auth/callback?code=${code}&state=${'0'.repeat(32)}`, { cookie: flowCookie });
        assert.strictEqual(bad.status, 302, 'the SDK recovers by itself once');
        assert.match(bad.headers.get('location'), /^\/auth\/login/);
        const retry = cookieJar(bad);
        assert.match(retry, /ov_oauth_retry=1/);
        const again = await t.get(`/auth/callback?code=${code}&state=${'0'.repeat(32)}`, { cookie: `${flowCookie}; ${retry}` });
        assert.strictEqual(again.status, 400);
        assert.match(again.text, /Try again/);
        const other = t.network.issueCode(user, crypto.createHash('sha256').update('another-verifier').digest('base64url'));
        assert.strictEqual((await t.get(`/auth/callback?code=${other}&state=${loc.searchParams.get('state')}`, { cookie: flowCookie })).status, 302);
        assert.strictEqual((await t.get(`/auth/callback?code=${code}&state=${loc.searchParams.get('state')}`)).status, 302);
    });

    await check('next= only accepts same-site paths', async () => {
        const r = await t.get('/auth/login?next=//evil.example/x');
        assert.ok(!/ov_oauth_next=[^;]+/.test(String(r.headers.get('set-cookie') || '')), 'another origin is never a target');
    });

    await check('/auth/health says whether the Network accepts this site\'s client', async () => {
        const r = await t.get('/auth/health');
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.json(), { ok: true, client: 'ok' });
    });

    await check('readiness is truthful: required db + the agents; JWKS, the OAuth client and Valkey are optional', async () => {
        const r = await t.get('/api/ready');
        const b = r.json();
        assert.strictEqual(r.status, 200);
        assert.strictEqual(b.checks.db.status, 'ok');
        assert.strictEqual(b.checks.db.required, true);
        assert.strictEqual(b.checks.agents.status, 'ok');
        assert.strictEqual(b.checks.agents.required, true);
        assert.strictEqual(b.checks.network_jwks.status, 'ok');
        assert.strictEqual(b.checks.oauth_client.status, 'ok');
        assert.strictEqual(b.checks.sso_client.status, 'ok');
        assert.strictEqual(b.checks.sso_client.required, true);
        assert.ok(!('docs' in b.checks) && !('events_relay' in b.checks), 'the console\'s checks moved with it');
    });

    await check('/release.json and /metrics (loopback only)', async () => {
        const rel = await t.get('/release.json');
        assert.strictEqual(rel.status, 200);
        assert.strictEqual(rel.json().service, 'actor');
        assert.deepStrictEqual(require('openvibe-contracts').validate('registry.release-manifest@1', rel.json()).errors, []);
        assert.strictEqual(rel.json().metrics_url, '/release-metrics');
        const m = await t.get('/metrics');
        assert.strictEqual(m.status, 200);
        assert.match(m.text, /http_requests_total|release_info/);
        const proxied = await t.get('/metrics', { headers: { 'x-forwarded-for': '203.0.113.9' } });
        assert.notStrictEqual(proxied.status, 200, 'a proxied request is not loopback');
    });

    await check('public pages are complete without JavaScript (noscript nav, SSR footer)', async () => {
        for (const p of ['/', '/agents', '/docs', '/updates']) {
            const r = await t.get(p);
            assert.strictEqual(r.status, 200, p);
            assert.match(r.text, /<noscript><nav/);
            assert.match(r.text, /<footer id="ov-footer"/);
            assert.match(r.text, /<main id="main"/);
        }
    });

    await t.close();
    done();
})();
