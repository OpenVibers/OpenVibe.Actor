'use strict';
/**
 * The fetch the tool tests use: it answers from the recorded answers in test/fixtures/tools, so the
 * suite never touches the network. A route is a host and path; its value is either the name of a
 * fixture file or a function that picks one from the whole URL.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'fixtures', 'tools');

function fixtureFetch(routes) {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        const text = String(url);
        calls.push({ url: text, headers: init.headers || {} });
        const u = new URL(text);
        const route = routes[u.host + u.pathname] !== undefined ? routes[u.host + u.pathname] : routes[u.host];
        if (!route) {
            return { ok: false, status: 404, text: async () => JSON.stringify({ message: 'no fixture for ' + u.host + u.pathname }) };
        }
        const file = typeof route === 'function' ? route(text, u) : route;
        if (!file) {
            return { ok: false, status: 404, text: async () => JSON.stringify({ message: 'no fixture for ' + text }) };
        }
        const body = fs.readFileSync(path.join(DIR, file), 'utf8');
        return { ok: true, status: 200, text: async () => body };
    };
    return { fetchImpl, calls };
}

/** The context the loop hands a tool: the egress-safe fetch and nothing else. */
const ctxOf = (fetchImpl) => ({ fetch: fetchImpl, signal: undefined, config: {} });

module.exports = { fixtureFetch, ctxOf, DIR };
