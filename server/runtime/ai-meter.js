'use strict';

/**
 * The process's one meter client (ai-metrics.md): every model call Actor makes itself — its providers, its own key
 * through OpenVibe.AI, the router — is recorded with openvibe-sdk/ai-meter and sent to AI's POST /api/v1/usage/calls.
 *
 * AI is also the only place that prices a call Actor did not route, so this client sends tokens, timing and outcome
 * only (never a price): AI applies its rate cards and publishes ai.call.recorded@1.
 *
 * Off in a drill and in tests, where the process makes no outbound calls, in a self-hosted Actor (no Network identity
 * to mint the service token), and without a Network client secret: a missing meter never stops a model call.
 */

const { serviceAuth } = require('openvibe-contracts');
const { createMeterClient } = require('openvibe-sdk/ai-meter');

function createAiMeter({ config, fetchImpl = globalThis.fetch, log = console } = {}) {
    const ai = config && config.ai;
    if (!ai || !ai.url || !ai.clientSecret) return null;
    if (config.drill || config.nodeEnv === 'test') return null;
    if (config.selfHosted && config.selfHosted.on) return null;
    const tokens = serviceAuth.createTokenClient({
        tokenUrl: (config.networkInternalUrl || config.networkUrl) + '/oauth/token',
        clientId: ai.clientId, clientSecret: ai.clientSecret,
        // Its own token, narrowed to reporting: a grant that is missing breaks metering only, never a model call.
        audience: ai.audience || 'openvibe.ai', scope: 'ai.usage.report', fetchImpl,
    });
    return createMeterClient({ aiUrl: ai.url, tokenClient: tokens, fetch: fetchImpl, log });
}

module.exports = { createAiMeter };
