'use strict';

const { serviceFor, json, personOf } = require('./_openvibe');
const { prepareDesk, deskKind, placementOrder, AGENT_PROFILE } = require('./_person');

/**
 * A task's own desk (Desks plan D1). The model only ever says desk "private"; on a machine that runs several desks
 * it is a desk named for this run, so two tasks at once never see or drive each other's screen, browser or files.
 * Machine "any" goes where there is room (D6): the person's machines first, then a browser-only desk on a desk host
 * through an OpenVibe.Run session. The engine's closeDesks stops every desk the run used when the task ends.
 */
async function startDesk(a, person, core, ctx) {
    const desks = ctx.state && ctx.state.desks;
    const { kind, ...rest } = a;
    const chosen = a.desk === 'private' ? kind : deskKind(desks, a.machine, kind);   // private: a whole desk
    const body = chosen ? { ...rest, kind: chosen } : rest;
    // The person's sign-ins carry from task to task (Node v0.24.0): every task's desk starts from the browser profile
    // kept for their agent on that machine, and saves it back when it stops. Never the model's choice.
    delete body.profile;
    if (body.desk !== 'private' && desks && desks.keeps && desks.keeps.has(a.machine)) body.profile = AGENT_PROFILE;
    return core.pcs.desk(person, body.machine, body, { signal: ctx.signal });
}

module.exports = {
    name: 'computer_desk',
    description: 'Start, stop or check the private desk on one of the person\'s computers: a screen of its own (when list_my_computers shows "desk" in can) where you work without touching the person\'s own screen. For start, machine may be "any": the desk goes on whichever of the person\'s computers has room (desk hosts first), and your other desk tools may then say machine "any" too. Start it before computer_screen, computer_input or computer_browser with desk "private", and stop it when the work is done. Where the machine lists desk_kinds, the desk is a browser desk by default (a browser alone: cheaper; computer_screen and computer_input then show and drive its page); ask for kind "desktop" only when the work needs apps or more than a browser. At level "ask" starting waits for the person to approve it on the machine.',
    input: { type: 'object', properties: { machine: { type: 'string', description: 'a machine id (dev_…), or "any" for start' }, action: { type: 'string', enum: ['start', 'stop', 'status'] }, kind: { type: 'string', enum: ['browser', 'desktop'], description: 'start: browser (a browser alone, the default where the machine runs them) or desktop (a whole screen with apps)' }, width: { type: 'integer', description: 'start: 640 to 3840 (default 1280)' }, height: { type: 'integer', description: 'start: 480 to 2160 (default 800)' } }, required: ['machine', 'action'] },
    scope: 'person',
    costUsd: 0,
    timeoutMs: 90_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.botUrl && personOf(ctx.requester)),
    async run(input, ctx) {
        const core = serviceFor(ctx);
        const person = personOf(ctx.requester);
        if (!core.pcs.enabled || !person) return { text: json({ error: 'computers are only for a signed-in person\'s task' }), isError: true };
        const desks = ctx.state && ctx.state.desks;
        let a = { ...input };

        // Machine "any": a desk start goes where there is room, the next machine when one is full.
        if (a.machine === 'any') {
            if (desks && desks.placed) a = { ...a, machine: desks.placed };
            else if (a.action === 'start') {
                const order = await placementOrder(person, { core, signal: ctx.signal });
                let out = null;
                for (const id of order.slice(0, 4)) {
                    out = await startDesk({ ...a, machine: id }, person, core, ctx);
                    if (!(out && out.error && /limit|max_desks|already runs/i.test(out.error))) {
                        if (out && !out.error && desks && !desks.placed) desks.placed = id;
                        return { text: json(out && !out.error ? { machine: id, ...out } : out), data: out };
                    }
                }
                // None of the person's own machines has room (or none runs desks): a browser desk on a desk host,
                // through an OpenVibe.Run session (Desks plan D6), for browser work only.
                if (core.pcs.sessionsOn && (a.kind == null || a.kind === 'browser')) {
                    const ses = await core.pcs.openSession(person, { taskId: desks && desks.taskId, width: a.width, height: a.height, signal: ctx.signal });
                    if (!ses.error) {
                        if (desks) desks.placed = ses.machine;
                        return { text: json({ machine: ses.machine, running: true, kind: 'browser', where: 'a desk host (none of your own computers had a desk free)', note: 'A browser alone, on a machine that is not the person\'s: computer_browser, computer_screen and computer_input work there with machine "any"; no programs or files. It ends with the task.' }), data: ses };
                    }
                    if (!order.length) return { text: json({ error: `none of the person's computers runs desks for you now, and ${ses.error}` }), isError: true };
                }
                if (!order.length) return { text: json({ error: 'none of the person\'s computers runs desks for you now: it needs OpenVibe Node v0.19.0 or newer, online, with "Let my agent use this computer" on' }), isError: true };
                return { text: json({ error: `every computer of the person's that runs desks is full right now (${out && out.error})` }), isError: true };
            } else return { text: json({ error: 'no desk of yours runs yet: start one with computer_desk start and machine "any"' }), isError: true };
        }

        const prepared = await prepareDesk('computer_desk', a, person, core, ctx);
        if (prepared.error) return { text: json(prepared), isError: true };
        a = prepared;
        if (a.action === 'start') {
            const out = await startDesk(a, person, core, ctx);
            if (out && !out.error && desks && !desks.placed) desks.placed = a.machine;
            return { text: json(out && out.running && !(core.pcs.isSession && core.pcs.isSession(a.machine)) ? { watch: core.pcs.watchUrl(a.machine, a.desk), ...out } : out), data: out };
        }
        const out = await core.pcs.desk(person, a.machine, a, { signal: ctx.signal });
        if (desks && out && !out.error) {
            if (a.action === 'stop' && desks.placed === a.machine) desks.placed = null;
        }
        return { text: json(out && out.running && a.action !== 'stop' && !(core.pcs.isSession && core.pcs.isSession(a.machine)) ? { watch: core.pcs.watchUrl(a.machine, a.desk), ...out } : out), data: out };
    },
};
