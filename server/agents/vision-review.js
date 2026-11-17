'use strict';

/**
 * Vision's review panel for a page the Design bot drew (plan §AD.25; the owner, 2026-11-17: "Interconnect openvibe.vision
 * with openvibe.design and codes and actor so that it can analyze interfaces and designs and improve and critique multi
 * model multi harness configurable"). computer_page_check hands each view's picture here: OpenVibe.Vision's
 * POST /api/v1/ui-review (Vision #225) runs its free pixel check, then up to three vision models at once on OpenVibe.Design's
 * rules, and merges what they found with how many of them saw each.
 *
 * Actor calls it with its own service token (audience openvibe.vision, vision.model.compare: Network #1085), naming the
 * person in X-OV-Subject. Vision's own account pays for the models, as it does for anyone. The panel's models are the
 * operator's choice (ACTOR_VISION_REVIEW_MODELS, comma separated; none: AI picks one).
 *
 *   createVisionReview({ config, fetchImpl?, tokens? }) → { enabled, review({ contentB64, width, height, theme, subject, signal }) }
 *       → Vision's review ({ merged, panel, gate, cost_usd, … }), or { error } in words, or null when it is off
 */
const { serviceAuth } = require('openvibe-contracts');

const USER_SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

function createVisionReview({ config, fetchImpl = globalThis.fetch, tokens: override = null } = {}) {
    const svc = (config && config.services) || {};
    const base = String(svc.visionUrl || '').replace(/\/+$/, '');
    const oauth = (config && config.oauth) || {};
    const enabled = !!(base && (override || oauth.clientSecret));
    const tokens = !enabled ? null : override || serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: oauth.clientId, clientSecret: oauth.clientSecret,
        audience: 'openvibe.vision', scope: 'vision.model.compare', fetchImpl,
    });
    const models = (Array.isArray(svc.visionReviewModels) ? svc.visionReviewModels : []).filter((m) => typeof m === 'string' && m.trim()).slice(0, 3);

    async function review({ contentB64, width, height, theme, subject = null, signal } = {}) {
        if (!enabled) return null;
        if (!contentB64) return { error: 'no picture' };
        let r;
        try {
            r = await fetchImpl(`${base}/api/v1/ui-review`, {
                method: 'POST', redirect: 'error',
                signal: signal || AbortSignal.timeout(90_000),
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(USER_SUBJECT.test(String(subject || '')) ? { 'X-OV-Subject': subject } : {}), ...(await tokens.authHeaders()) },
                body: JSON.stringify({ image: `data:image/jpeg;base64,${contentB64}`, viewport: { w: Number(width) || 1280, h: Number(height) || 800 }, ...(theme ? { theme } : {}), ...(models.length ? { models } : {}) }),
            });
        } catch (err) {
            return { error: `Vision did not answer: ${String((err && err.message) || err).slice(0, 160)}` };
        }
        if (!r.ok) return { error: `Vision answered ${r.status}` };
        const j = await r.json().catch(() => null);
        return j && j.review && typeof j.review === 'object' ? j.review : { error: 'Vision gave no review' };
    }

    /** The merged findings as a few lines a model reads: the worst first, with how many critics saw each. */
    function words(rv, limit = 5) {
        const merged = Array.isArray(rv && rv.merged) ? rv.merged : [];
        const critics = Array.isArray(rv && rv.panel) ? rv.panel.filter((p) => p && p.ok).length : 0;
        if (!merged.length) return critics ? `nothing wrong (${critics} model${critics === 1 ? '' : 's'} looked)` : null;
        return merged.slice(0, limit).map((f) => `${f.severity}: ${String(f.says || '').slice(0, 220)}${f.fix ? ` Fix: ${String(f.fix).slice(0, 160)}` : ''}${f.rule && f.rule !== 'checklist' ? ` [${f.rule}]` : ''}${critics > 1 ? ` (${f.agreement || 1} of ${critics} models)` : ''}`).join('\n');
    }

    return { enabled, review, words, models };
}

module.exports = { createVisionReview };
