'use strict';
// The Markdown twins of openvibe.actor's public pages (openvibe-shared/agent-layer), rendered by the same
// page builders the routes use (createPageRoutes().publicViews + render/layout.js's renderPage), so a twin
// cannot drift from its page. Anonymous only. Named agent-layer-pages because server/http/agent-pages.js
// already means a person's own agents, and a task page is behind a token: it is not here.
const { renderPage } = require('./render/layout');

function createAgentLayerPages(ctx, publicViews) {
    const views = publicViews;
    const twin = (page, path) => (page ? { html: renderPage({ ...page, viewer: { kind: 'anonymous' }, config: ctx.config, path }) } : null);

    async function renderPublicPage(path) {
        if (path === '/') return twin(await views.home(), path);
        if (path === '/agents') return twin(views.agents(), path);
        if (path === '/docs') return twin(views.docs(), path);
        if (path === '/updates') return twin(views.updates(), path);
        return null;
    }

    return { renderPublicPage };
}

module.exports = { createAgentLayerPages };
