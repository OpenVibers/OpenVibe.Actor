'use strict';
/**
 * A self-hosted Actor bursting to OpenVibe's hosted models (plan T17 4, the hybrid): the operator registers a
 * developer app on OpenVibe (its project pays and owns the runs), and this source turns the app's client id and
 * secret into the five-minute Network token ai.openvibe.services takes (client credentials, audience openvibe.ai,
 * the app's approved `ai.app.run`). It is the runtime client's apiKey: a function, asked before each call, that
 * answers the cached token until 30 s before it expires and fetches a new one after that, or after a 401
 * (`refresh()`). Network gives apps no refresh tokens, so this is the whole lifecycle.
 */
const SKEW_MS = 30_000;

class AppTokenError extends Error {
    constructor(message) { super(message); this.code = 'actor.provider.error'; }
}

function appTokenSource({ networkUrl, clientId, clientSecret, audience = 'openvibe.ai', fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    let cached = null;   // { token, until }
    let pending = null;

    async function fetchToken() {
        let res;
        try {
            res = await fetchImpl(`${networkUrl}/oauth/token`, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
                body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, audience }).toString(),
                signal: AbortSignal.timeout(15_000),
            });
        } catch {
            throw new AppTokenError('OpenVibe could not be reached for a token');
        }
        const j = await res.json().catch(() => null);
        if (!res.ok || !j || typeof j.access_token !== 'string') {
            const why = (j && (j.error_description || j.error)) || `HTTP ${res.status}`;
            throw new AppTokenError(`OpenVibe refused the app's token: ${String(why).slice(0, 200)}`);
        }
        const ttlMs = Math.max(60, Number(j.expires_in) || 300) * 1000;
        cached = { token: j.access_token, until: now() + ttlMs - SKEW_MS };
        return cached.token;
    }

    async function token() {
        if (cached && now() < cached.until) return cached.token;
        if (!pending) pending = fetchToken().finally(() => { pending = null; });
        return pending;
    }
    token.refresh = () => { cached = null; };
    return token;
}

module.exports = { appTokenSource, AppTokenError };
