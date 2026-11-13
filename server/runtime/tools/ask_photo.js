'use strict';

const device = require('./_device');

module.exports = {
    name: 'ask_photo',
    description: 'Ask your person to take one photo themselves. Say why. Their phone opens the system camera only after their tap; they can also choose a photo in the browser. Each photo needs a fresh answer. The run waits for that one answer.',
    input: { type: 'object', properties: { why: { type: 'string', maxLength: 300 },
        device: { type: 'string', description: 'Optional paired phone id (dev_…). If it is offline, this request fails plainly. Without one, the person may answer on any phone or in a browser.' } }, required: ['why'] },
    scope: 'person', acts: true, costUsd: 0, timeoutMs: 30_000,
    connector: 'phone',
    available: device.ready,
    run: (input, ctx) => device.ask(ctx, 'device.camera', input),
};
