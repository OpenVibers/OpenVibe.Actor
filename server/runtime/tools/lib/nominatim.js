'use strict';
/**
 * OpenStreetMap Nominatim, the map search Actor uses when a name has to become a place.
 *
 * Nominatim's usage policy (https://operations.osmfoundation.org/policies/nominatim/): a real
 * application User-Agent with a way to reach us, at most one request a second, no heavy use, and
 * results that are cached rather than asked for again. This module keeps all four: the User-Agent
 * below names Actor and its address, the limiter spaces the calls a second apart, and the cache
 * holds an answer for an hour. We only ever search for a complete place name.
 */
const { Cache, HostLimiter, MAPS_USER_AGENT, requestJson, memo } = require('./util');

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const LIMITER = new HostLimiter({ gapMs: 1000 });
const CACHE = new Cache({ max: 128 });
const TTL_MS = 60 * 60 * 1000;

/** The places Nominatim knows for a name, best first. */
async function search(ctx, query, { limit = 1, signal } = {}) {
    const key = 'nominatim:' + String(query).trim().toLowerCase() + ':' + limit;
    return await memo(CACHE, key, TTL_MS, async () => {
        await LIMITER.wait('nominatim.openstreetmap.org');
        const url = ENDPOINT
            + '?q=' + encodeURIComponent(String(query).trim())
            + '&format=jsonv2&limit=' + limit + '&addressdetails=1&extratags=1&namedetails=1';
        const { data } = await requestJson(ctx, url, {
            signal,
            headers: { 'user-agent': MAPS_USER_AGENT },
            label: 'OpenStreetMap Nominatim',
        });
        return Array.isArray(data) ? data : [];
    });
}

module.exports = { search, ENDPOINT };
