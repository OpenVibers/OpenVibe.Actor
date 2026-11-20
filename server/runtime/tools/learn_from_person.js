'use strict';

const { serviceFor, json, personOf } = require('./_openvibe');
const driving = require('../../agents/driving');

// A tool may run at most 15 minutes (the registry), so a lesson lasts up to 14 and the skill is written in the last one.
const TEACH_WAIT_MS = 14 * 60_000;
const POLL_MS = 2000;

/**
 * learn_from_person (Teach a task, plan §AD.33): the person shows the agent a task on its own desk, once, and the agent
 * keeps it as a skill.
 *
 * The person presses "Show it" on the desk (Actor's viewer: Take over), does the task, and presses Done (Hand back).
 * Every input they send through the viewer is a step of the task (server/teach/recorder.js, from the input route); when
 * they are done, a vision model writes those steps and the pictures they clicked on up as a skill draft
 * (server/teach/draft.js) that waits on the agent's page for them to read, edit and keep. Nothing the person typed as
 * private text reaches the model, and what they typed is wiped from the record once the draft is written.
 */
module.exports = {
    name: 'learn_from_person',
    description: 'Learn a task by watching your person do it once on your own desk, and keep it as a skill you can use next time. Start your desk first (computer_desk) and open the first page. The person takes the desk over, does the task, and presses Done; this waits for them (up to 14 minutes), then writes the skill from what they did and leaves it on your page for them to keep. Use it when the person offers to show you how, or when you cannot do a step and they can show you.',
    input: {
        type: 'object',
        properties: {
            machine: { type: 'string', description: 'the machine your desk is on (dev_…), or "any" when you started it with machine "any"' },
            what: { type: 'string', description: 'the task they will show you, in one plain sentence, for example "Post a clip to my X account."' },
        },
        required: ['what'],
    },
    scope: 'person',
    needs: { files: 'none', network: false },   // plan 11c: the run's files and network settings gate it
    acts: true,
    costUsd: 0.03,
    timeoutMs: 900_000,
    available: (ctx) => Boolean(ctx.config && ctx.config.services && ctx.config.services.botUrl && personOf(ctx.requester) && ctx.agentId && ctx.store),
    async run(input, ctx) {
        const core = serviceFor(ctx);
        const person = personOf(ctx.requester);
        if (!core.pcs.enabled || !person) return { text: json({ error: 'teaching is only for a signed-in person\'s agent' }), isError: true };
        const what = String((input && input.what) || '').replace(/\s+/g, ' ').trim().slice(0, 300);
        if (!what) return { text: json({ error: 'what: the task the person will show you, in a sentence' }), isError: true };
        const s = ctx.store;
        const teach = require('../../teach');
        const recorder = require('../../teach/recorder');
        const draft = require('../../teach/draft');
        const stills = require('../../tasks/stills');
        const tasks = require('../../tasks/store');
        const personal = require('../../agents/personal');
        // A desk must be open: the person needs something to show it on.
        const row = await tasks.getTask(s, ctx.taskId);
        const placed = Boolean(ctx.state && ctx.state.desks && ctx.state.desks.placed);
        if (!row || (!placed && !(await tasks.taskDesk(s, row)) && !(await tasks.taskComputer(s, row)))) {
            return { text: json({ error: 'Start your desk first (computer_desk action "start"), then open the first page, then call this again.' }), isError: true };
        }
        // The steps after this point are the lesson.
        const from = Number(row.last_seq) || 0;
        await teach.watching(s, ctx.taskId).catch(() => null);
        const granted = ctx.waitForPerson ? ctx.waitForPerson(TEACH_WAIT_MS, { teach: true }) : TEACH_WAIT_MS;
        if (!granted) return { text: json({ done: false, note: 'This task has already waited for the person as long as it may: tell them to start a new teach session from your page.' }) };
        const url = `${ctx.config.baseUrl}/tasks/${ctx.taskId}`;
        if (ctx.emit) await ctx.emit({ step: 'text', text: `Needs you: Show me how: ${what} Press "Show it" on the desk, do it once, then press Done.` });
        if (ctx.notifyTask) ctx.notifyTask('needs_you', { what: `Show your agent how: ${what}`, url }).catch(() => {});
        const end = Date.now() + granted;
        let took = false;
        let ended = false;
        const pause = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (ctx.signal) ctx.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); });
        while (Date.now() < end && !(ctx.signal && ctx.signal.aborted)) {
            // Taking the desk is the start; their steps prove it even when a whole short lesson fell between two looks.
            if (driving.is(ctx.taskId) || (!took && await recorder.count(s, ctx.taskId, { after: from }) > 0)) took = true;
            if (took && !driving.is(ctx.taskId)) { ended = true; break; }
            await pause(POLL_MS);
        }
        if (ctx.signal && ctx.signal.aborted) return { text: json({ done: false, note: 'The task was stopped.' }) };
        const steps = await recorder.steps(s, ctx.taskId, { after: from });
        if (!steps.length) {
            await teach.finish(s, ctx.taskId, { state: 'empty', steps: 0 }).catch(() => null);
            return { text: json({ done: false, note: took ? 'The person gave the desk back without doing anything on it: tell them nothing was recorded, and that they can teach you again from your page.' : `The person did not show you anything in ${Math.round(granted / 60000)} minutes: tell them they can teach you any time from your page.` }) };
        }
        // Their last words on hand-back, if any, came to the run as a steer; the steps are what count.
        const out = await draft.write({ models: ctx.models, subject: person, what, steps, picture: (seq) => stills.get(s, ctx.taskId, seq), signal: ctx.signal });
        if (out.cost_usd && ctx.meter) await ctx.meter(out.cost_usd);
        if (out.error) {
            await teach.finish(s, ctx.taskId, { state: 'failed', steps: steps.length }).catch(() => null);
            await recorder.forget(s, ctx.taskId).catch(() => {});
            return { text: json({ done: false, steps: steps.length, error: out.error, note: 'Tell the person the skill could not be written this time and that they can teach you again.' }), isError: true };
        }
        const proposal = await personal.addSkillProposal(s, ctx.requester, ctx.agentId, out.draft, ctx.taskId, { source: 'teach', force: true });
        await teach.finish(s, ctx.taskId, { state: proposal ? 'drafted' : 'failed', steps: steps.length, proposalId: proposal ? proposal.id : null }).catch(() => null);
        await recorder.forget(s, ctx.taskId).catch(() => {});
        return {
            text: json({
                done: true, finished: ended ? 'they pressed Done' : 'the wait ended', steps: steps.length,
                skill: { name: out.draft.name, description: out.draft.description },
                note: proposal ? 'The skill draft waits on your page and on this task for the person to read, edit and keep.' : 'The draft could not be saved (too many suggestions wait): tell the person to decide on those first.',
            }),
            data: { done: true, steps: steps.length, proposal: proposal ? proposal.id : null },
        };
    },
};
