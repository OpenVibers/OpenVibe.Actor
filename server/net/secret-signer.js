'use strict';
/**
 * Signing with a project secret (ADR-056): OpenVibe.Network's POST /internal/secrets/use, purpose sign, with Actor's own
 * service token (network.secret.use, audience openvibe.network). Network answers HMAC-SHA256 of the message under the
 * secret the project granted to actor; the value never reaches Actor.
 *
 *   sign({ project_id, environment, name, message }) → { signature, version }
 *     throws SecretRefused (404 secret.not_found: no such secret, or not granted to actor for sign; final)
 *     throws any other error for a transient failure (retried by the caller)
 */
const { serviceAuth } = require('openvibe-contracts');

class SecretRefused extends Error {}

function createSecretSigner({ config, fetchImpl = globalThis.fetch }) {
    const enabled = Boolean(config.networkInternalUrl && config.oauth && config.oauth.clientSecret);
    const tokens = enabled ? serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network', scope: 'network.secret.use', fetchImpl,
    }) : null;
    async function sign({ project_id, environment, name, message }) {
        if (!tokens) throw new Error('project secrets are unavailable: Actor has no Network client secret');
        const res = await fetchImpl(`${config.networkInternalUrl}/internal/secrets/use`, {
            method: 'POST',
            headers: { ...(await tokens.authHeaders()), 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ project_id, environment, name, purpose: 'sign', message }),
            signal: AbortSignal.timeout(5000),
        });
        const data = await res.json().catch(() => null);
        if (res.status === 401 && tokens.invalidate) tokens.invalidate();
        if (res.status === 404) throw new SecretRefused(`project secret ${name} (${environment}) does not exist or is not granted to actor for sign`);
        if (!res.ok || !data || !/^[0-9a-f]{64}$/.test(String(data.signature || ''))) throw new Error(`Network answered ${res.status}${data && data.code ? ` ${data.code}` : ''}`);
        return { signature: data.signature, version: data.version };
    }
    return { enabled, sign };
}

module.exports = { createSecretSigner, SecretRefused };
