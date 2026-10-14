'use strict';

/**
 * The person's own robots on OpenVibe.Bot, as two runtime tools (plan T15/T17: an Actor agent pilots a robot under the
 * owner's grant, always through Bot). Actor calls Bot's public API with its own service token (audience openvibe.bot,
 * bot.robot.read + bot.robot.control) and X-OV-Subject naming the person the task is for. Bot answers only for the
 * robot's owner, and only where that owner turned on "Let my OpenVibe.Actor agent drive this robot"; its gate, limits,
 * cooldowns and e-stop judge every step, and its audit records each one as svc:actor.
 *
 *   createRobots({ config, fetchImpl, tokens? }) → { enabled, mine(subject), steps(subject, robotId, lines) }
 *     mine     → [{ id, name, model, agent_control, online?, estop?, battery?, sensors?, steps?[], panel }]
 *     steps    → { result: 'done' | 'stopped: …', steps } or { error }
 *
 * Off (enabled false) without ACTOR_BOT_URL or without Actor's client secret.
 */
const { serviceAuth } = require('openvibe-contracts');

const ROBOT_ID = /^rob_[0-9A-HJKMNP-TV-Z]{26}$/;
const USER_SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

function createRobots({ config, fetchImpl = globalThis.fetch, tokens: tokensOverride = null }) {
    const base = config.services.botUrl;
    const pages = config.services.botPublicUrl || base;
    const enabled = !!(base && (tokensOverride || config.oauth.clientSecret));
    const tokens = !enabled ? null : tokensOverride || serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.bot', scope: 'bot.robot.read bot.robot.control', fetchImpl,
    });

    async function call(method, path, subject, { body, signal, timeoutMs = 15_000 } = {}) {
        const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
        const res = await fetchImpl(`${base}/api/v1${path}`, {
            method,
            headers: { Accept: 'application/json', 'X-OV-Subject': subject, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await tokens.authHeaders()) },
            body: body ? JSON.stringify(body) : undefined, signal: sig,
        });
        const data = await res.json().catch(() => null);
        return { status: res.status, ok: res.ok, data };
    }
    const problem = (r, what) => ({ error: (r.data && (r.data.detail || r.data.title)) || `Bot answered ${r.status} for ${what}`, code: (r.data && r.data.code) || null });

    async function mine(subject, { signal } = {}) {
        if (!USER_SUBJECT.test(subject)) return { error: 'robots are only for a signed-in person' };
        const r = await call('GET', `/robots?owner=${encodeURIComponent(subject)}`, subject, { signal });
        if (!r.ok) return problem(r, 'your robots');
        const out = [];
        for (const robot of (r.data && r.data.robots) || []) {
            const item = { id: robot.id, name: robot.name, model: robot.profile_id, agent_control: !!robot.agent_control, panel: `${pages}/panel/${robot.id}` };
            if (!robot.agent_control) {
                item.note = `Not open to the agent. The owner can turn on "Let my OpenVibe.Actor agent drive this robot" at ${pages}/panel/${robot.id}#agent`;
            } else {
                const s = await call('GET', `/robots/${robot.id}/steps`, subject, { signal });
                if (s.ok && s.data) Object.assign(item, { online: s.data.online, estop: s.data.estop, battery: s.data.battery, sensors: s.data.sensors, steps: s.data.steps, max_steps: s.data.max_steps, max_seconds: s.data.max_seconds });
                else item.note = problem(s, 'the robot').error;
            }
            out.push(item);
        }
        return out;
    }

    async function steps(subject, robotId, lines, { signal } = {}) {
        if (!USER_SUBJECT.test(subject)) return { error: 'robots are only for a signed-in person' };
        if (!ROBOT_ID.test(String(robotId || ''))) return { error: 'robot must be a robot id from list_my_robots (rob_…)' };
        const text = Array.isArray(lines) ? lines.map(String).join('\n') : String(lines || '');
        if (!text.trim()) return { error: 'steps are one or more lines, for example "forward 1" and "say Hello"' };
        // The robot runs the steps before Bot answers: up to 30 s of steps, plus room for the device's replies.
        const r = await call('POST', `/robots/${robotId}/steps`, subject, { body: { steps: text.slice(0, 2000) }, signal, timeoutMs: 45_000 });
        if (!r.ok) return problem(r, 'the steps');
        return { result: r.data.result, steps: r.data.steps };
    }

    return { enabled, mine, steps };
}

module.exports = { createRobots };
