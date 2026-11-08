'use strict';
const fallback = require('./frame-origins.json');
function createFrames({ fetchImpl = globalThis.fetch, networkUrl }) {
    let origins = fallback, until = 0, pending;
    return async function get() {
        if (Date.now() < until) return origins;
        if (!pending) pending = (async () => {
            until = Date.now() + 600_000;
            try {
                const r = await fetchImpl(`${networkUrl}/api/frame?host=openvibe.actor`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
                if (!r.ok) return;
                const data = await r.json();
                const next = [...(data.nav || []), ...(data.soon || [])].map(s => {
                    const u = new URL(s.url);
                    return u.protocol === 'https:' && !u.username && !u.password && !u.port ? u.origin : null;
                }).filter(Boolean);
                if (next.length) origins = [...new Set([...fallback, ...next])];
            } catch { /* keep the checked-in first-party list */ }
            finally { pending = null; }
        })();
        await pending;
        return origins;
    };
}
module.exports = { createFrames };
