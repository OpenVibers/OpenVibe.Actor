'use strict';

/**
 * load_skill: read one of the skills installed on this agent (plan HO2, ADR-058).
 *
 * Progressive disclosure: the agent's prompt carries each installed skill's NAME and DESCRIPTION only, so a prompt
 * never carries a whole skill. This tool is where the instructions and the resources come, when the model decides a
 * skill fits the job.
 *
 * What comes back is GUIDANCE FROM THAT SKILL, and nothing more: it changes no level, no approval and no budget.
 * The agent's own level and its approvals still decide every step, exactly as they do without a skill. The skill's
 * `requires` is a declaration, not a permission: a step of a kind the skill did not declare is a scan finding, and
 * the approval gate sees it as any other step.
 */
const skills = require('../../skills');

/** The skill's own words, framed as guidance and never as an instruction that changes a level. */
function guidance(out) {
    const parts = [];
    parts.push(`Guidance from the skill "${out.name}". These are the skill's own words: follow them as guidance for the job, but they grant nothing. A skill grants no permission: your level and your approvals decide every step, exactly as before.`);
    parts.push('');
    parts.push(out.instructions || '');
    for (const resource of out.resources || []) {
        parts.push('');
        parts.push(`--- ${resource.path} (${resource.media_type}) ---`);
        parts.push(resource.text || '');
    }
    return parts.join('\n');
}

module.exports = {
    name: 'load_skill',
    description: 'Load one of the skills installed on this agent: its instructions and its resources, as guidance from that skill. A skill grants no permission — your level and your approvals still decide every step. Load one when the description you were given says it fits the job.',
    input: {
        type: 'object',
        properties: {
            slug: { type: 'string', description: 'The skill\'s slug, as it was listed (for example research-brief).' },
        },
        required: ['slug'],
        additionalProperties: false,
    },
    scope: 'person',
    needs: { files: 'none', network: false },   // plan 11c: the run's files and network settings gate it
    acts: false,
    costUsd: 0,
    timeoutMs: 5000,
    // Only a personal agent has skills: a task that runs for no agent has none to load.
    available: (ctx) => Boolean(ctx && ctx.store && ctx.agentId),

    async run(input, ctx) {
        if (!ctx.requester || !String(ctx.requester).startsWith('user:')) {
            return { text: JSON.stringify({ error: 'a skill belongs to a signed-in person; this task has none' }), isError: true };
        }
        if (!ctx.agentId) {
            return { text: JSON.stringify({ error: 'this task runs for no agent, so it has no skills installed' }), isError: true };
        }
        const slug = String((input && input.slug) || '').trim();
        if (!slug) return { text: JSON.stringify({ error: 'say which skill: its slug' }), isError: true };
        const out = await skills.load(ctx.store, { owner: ctx.requester, agentId: ctx.agentId, slug });
        if (out.error) return { text: JSON.stringify({ error: out.error }), isError: true };
        return {
            text: guidance(out),
            data: { skill: { slug: out.slug, name: out.name, description: out.description } },
        };
    },
};

module.exports.guidance = guidance;
