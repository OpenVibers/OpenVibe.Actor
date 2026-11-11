'use strict';
const assert = require('assert');
const { createTitleFallback } = require('../server/agent-ui/titles');
const { clean } = require('../server/agent-ui/redact');
(async () => {
    const calls = [];
    const fallback = createTitleFallback({ config: { networkUrl: 'https://network.test', oauth: { clientId: 'test', clientSecret: 'test-only-value' } }, clean,
        fetchImpl: async (url, opts) => {
            calls.push({ url: String(url), body: opts.body });
            const body = String(url).endsWith('/oauth/token') ? { access_token: 'test-only-token', token_type: 'Bearer', expires_in: 3600 }
                : String(url).endsWith('/v1/models') ? { data: [{ id: 'large' }, { id: 'small-mini' }] }
                    : { choices: [{ message: { content: 'Checked the project' } }] };
            return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
        } });
    assert.equal(await fallback('custom_check', { path: 'src', password: 'private-test-data' }), 'Checked the project');
    assert.equal(await fallback('custom_check', { path: 'src' }), 'Checked the project');
    const completions = calls.filter((c) => c.url.endsWith('/chat/completions'));
    assert.equal(completions.length, 1);
    assert.equal(completions[0].url, 'https://api.openvibe.exchange/v1/chat/completions');
    assert.equal(JSON.parse(completions[0].body).model, 'small-mini');
    assert(!JSON.stringify(calls).includes('private-test-data'));
    console.log('Exchange-only small-model fallback: cached, bounded, no output or credentials in prompt');
})().catch((e) => { console.error(e); process.exit(1); });
