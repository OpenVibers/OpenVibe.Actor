'use strict';
const { services, http } = require('openvibe-contracts');
// Match Network's manifest-based first-party list; never include hosted tenant subdomains.
const origins = new Set((services.manifests || []).flatMap(m => m.domains || []).map(d => `https://${d}`));
origins.add('https://openvibe.computer');
function cors(config) {
    return (req, res, next) => {
        const origin = req.get('origin');
        if (!origin || origin === config.baseUrl) return next();
        res.vary('Origin');
        if (!origins.has(origin)) return http.sendProblem(res, 403, 'cors.origin_denied', { ctx: req.ov });
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, PATCH, DELETE, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        if (req.method === 'OPTIONS') return res.sendStatus(204);
        if (!/^Bearer /i.test(req.get('authorization') || '')) return http.sendProblem(res, 401, 'token.required', { ctx: req.ov });
        next();
    };
}
module.exports = { cors };
