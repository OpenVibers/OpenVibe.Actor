'use strict';

const { json, personOf } = require('./_openvibe');

/**
 * learn_from_words (Teach a task told in words, plan §AD.33; the owner, 11-21: "build modular intelligent teach
 * feature"): the person wrote how they do a task instead of showing it on the desk. This writes the skill from their
 * words (server/teach/draft.js fromWords), as a draft that waits on the agent's page for them to read, edit and keep;
 * once kept, the agent practises it on its desk (server/teach/practice.js) and improves it where the words fell short.
 *
 * The words are read from the lesson itself (actor_teach_sessions.words), never from the model's input, so nothing the
 * model says can change what the person wrote.
 */
module.exports = {
    name: 'learn_from_words',
    description: 'In a lesson your person told you in words: write the skill from their words. It takes no input; it reads the lesson and leaves the skill draft on your page for them to keep.',
    input: { type: 'object', properties: {} },
    scope: 'person',
    needs: { files: 'none', network: false },
    acts: false,
    costUsd: 0.02,
    timeoutMs: 120_000,
    available: (ctx) => Boolean(personOf(ctx.requester) && ctx.agentId && ctx.store),
    async run(_input, ctx) {
        const s = ctx.store;
        const teach = require('../../teach');
        const lesson = await teach.session(s, ctx.taskId);
        if (!lesson || lesson.source !== 'words' || !lesson.words) return { text: json({ error: 'This is not a lesson told in words.' }), isError: true };
        const out = await require('../../teach/draft').fromWords({ models: ctx.models, subject: personOf(ctx.requester), what: lesson.what, words: lesson.words, startUrl: lesson.start_url, signal: ctx.signal });
        if (out.cost_usd && ctx.meter) await ctx.meter(out.cost_usd);
        if (out.error) {
            await teach.finish(s, ctx.taskId, { state: 'failed', steps: 0 }).catch(() => null);
            return { text: json({ done: false, error: out.error, note: 'Tell the person the skill could not be written from their words and that they can teach you again.' }), isError: true };
        }
        const proposal = await require('../../agents/personal').addSkillProposal(s, ctx.requester, ctx.agentId, out.draft, ctx.taskId, { source: 'teach', force: true });
        await teach.finish(s, ctx.taskId, { state: proposal ? 'drafted' : 'failed', steps: 0, proposalId: proposal ? proposal.id : null }).catch(() => null);
        return {
            text: json({
                done: Boolean(proposal), skill: { name: out.draft.name, description: out.draft.description },
                practice: Number(lesson.practice_rounds) > 0 ? `once they keep it, you practise it on your desk (up to ${lesson.practice_rounds} tr${Number(lesson.practice_rounds) === 1 ? 'y' : 'ies'})` : 'off',
                note: proposal ? 'The skill draft waits on your page for the person to read, edit and keep.' : 'The draft could not be saved: tell the person to decide on the suggestions that wait first.',
            }),
            data: { done: Boolean(proposal), proposal: proposal ? proposal.id : null },
        };
    },
};
