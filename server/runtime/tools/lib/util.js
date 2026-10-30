'use strict';
/**
 * Shared plumbing for Actor's live-data tool modules (server/runtime/tools/).
 *
 * Every outbound call goes through the fetch the loop hands a tool (ctx.fetch). A URL is always
 * built here from a fixed provider base plus the model's own words, encoded into the query, so
 * there is never an address a caller or a model chose. The hosts these modules need the fetch to
 * allow:
 *   api.open-meteo.com, geocoding-api.open-meteo.com, api.coingecko.com, api.frankfurter.dev,
 *   api.frankfurter.app, www.thesportsdb.com, nominatim.openstreetmap.org, en.wikipedia.org
 *   (and the other language hosts of Wikipedia).
 */
const USER_AGENT = 'OpenVibeActor/2.0 (+https://openvibe.actor)';
/** Nominatim asks for an application User-Agent with a way to reach us. */
const MAPS_USER_AGENT = 'OpenVibe.Actor/2.0 (https://openvibe.actor; contact@openvibe.actor)';

/** An error the model can act on: it becomes the tool's error text, never a crash. */
class ToolError extends Error {
    constructor(message, code = 'tool.error') {
        super(message);
        this.name = 'ToolError';
        this.code = code;
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An in-process cache with a TTL and a size cap. */
class Cache {
    constructor({ max = 256 } = {}) {
        this.max = max;
        this.entries = new Map();
    }

    get(key) {
        const hit = this.entries.get(key);
        if (!hit) return undefined;
        if (hit.expires <= Date.now()) {
            this.entries.delete(key);
            return undefined;
        }
        return hit.value;
    }

    set(key, value, ttlMs) {
        this.entries.set(key, { value, expires: Date.now() + ttlMs });
        while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value);
    }
}

/** Remember a result for ttlMs, so the same call twice in a minute costs one request. */
async function memo(cache, key, ttlMs, produce) {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const value = await produce();
    cache.set(key, value, ttlMs);
    return value;
}

/** At most one call per host every gapMs (Nominatim asks for no more than one a second). */
class HostLimiter {
    constructor({ gapMs = 1000 } = {}) {
        this.gapMs = gapMs;
        this.nextAt = new Map();
    }

    async wait(host) {
        const now = Date.now();
        const at = Math.max(now, this.nextAt.get(host) || 0);
        this.nextAt.set(host, at + this.gapMs);
        if (at > now) await sleep(at - now);
    }
}

/** The loop's fetch. A tool without one cannot reach the network, and says so. */
function fetchOf(ctx) {
    if (ctx && typeof ctx.fetch === 'function') return ctx.fetch;
    throw new ToolError('this tool needs the fetch the loop hands it (ctx.fetch); it has none', 'tool.no_fetch');
}

/** One GET, with the task's signal and a timeout, and JSON in hand. */
async function requestJson(ctx, url, { signal, headers = {}, label = 'the source', timeoutMs = 15000 } = {}) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res;
    try {
        res = await fetchOf(ctx)(url, {
            method: 'GET',
            headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...headers },
            signal: sig,
        });
    } catch (err) {
        if (err && err.name === 'ToolError') throw err;
        throw new ToolError(label + ' could not be reached: ' + ((err && err.message) || 'network error'), 'tool.network');
    }
    const status = res && typeof res.status === 'number' ? res.status : 200;
    let data = null;
    if (res && typeof res.text === 'function') {
        const text = await res.text();
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            data = null;
        }
        if (!data && status >= 200 && status < 300) throw new ToolError(label + ' answered with something that is not JSON', 'tool.bad_answer');
        if (!data) throw new ToolError(label + ' answered ' + status, 'tool.http');
    } else if (res && typeof res.json === 'function') {
        data = await res.json();
    }
    if (status < 200 || status >= 300) {
        const detail = (data && (data.error || data.message || data.detail)) || ('status ' + status);
        throw new ToolError(label + ' answered ' + status + ': ' + detail, 'tool.http');
    }
    return { status, data };
}

/** A number for a person: no float noise, no negative zero. */
function round(value, digits = 10) {
    if (!Number.isFinite(value)) return value;
    const r = Number(value.toPrecision(digits));
    return Object.is(r, -0) ? 0 : r;
}

/** The same number with a thousands separator, for a text line a person reads. */
function group(value) {
    const n = round(value, 10);
    if (!Number.isFinite(n)) return String(n);
    const fixed = Math.abs(n) >= 1000 ? n.toFixed(2) : String(n);
    const parts = fixed.split('.');
    const whole = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts[1] ? whole + '.' + parts[1] : whole;
}

/**
 * A tool that could not answer. The message is in the error, in the text the model reads and in the
 * isError flag the loop marks the step with, so nothing is lost on the way out.
 */
const fail = (message) => ({ error: message, text: message, isError: true });

/** The provider's page for the data: every result carries it as its evidence. */
const source = (url, title) => ({ url, title });

module.exports = {
    USER_AGENT,
    MAPS_USER_AGENT,
    ToolError,
    Cache,
    HostLimiter,
    memo,
    requestJson,
    round,
    group,
    source,
    fail,
};
