'use strict';
// What openvibe.actor tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this site really serves; /docs is the API reference and the JSON API is /api/v1.
// A task page is behind a person's token, so it is never part of this surface.
module.exports = {
    id: 'actor',
    name: 'OpenVibe.Actor',
    purpose: 'A router for agent work: a task in plain words goes to the best agent system for it, a second model family checks the answer, and the task records its cost and why that agent.',
    home: 'https://openvibe.actor',
    site: 'openvibe.actor',
    api: '/api/v1',
    docs: '/docs',
    policy: {
        auth: ['none', 'Network OIDC', 'bearer'],
        rateLimit: '240 API requests a minute per address; 300 page requests a minute; 60 sign-in attempts per 15 minutes',
    },
};
