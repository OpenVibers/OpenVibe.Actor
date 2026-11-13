'use strict';

const device = require('./_device');

module.exports = {
    name: 'ask_location',
    description: 'Ask your person to share their location once. Say why and whether precise location would help. They choose approximate by default and may share precise only when you requested it. Each location needs a fresh answer. The run waits for that one answer.',
    input: { type: 'object', properties: { why: { type: 'string', maxLength: 300 }, precise: { type: 'boolean' },
        device: { type: 'string', description: 'Optional paired phone id (dev_…). If it is offline, this request fails plainly. Without one, the person may answer on any phone or in a browser.' } }, required: ['why'] },
    scope: 'person', acts: true, costUsd: 0, timeoutMs: 30_000,
    needs: { files: 'none', network: false },   // plan 11c: the run's files and network settings gate it
    connector: 'phone',
    available: device.ready,
    run: (input, ctx) => device.ask(ctx, 'device.location', input),
};
