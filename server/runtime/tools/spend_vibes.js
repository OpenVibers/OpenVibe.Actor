'use strict';

/**
 * spend_vibes: tip a creator on OpenVibe with the person's own Vibes (plan HO7).
 *
 * The tool never pays. It asks: the step is money, so it always reaches the person's approval floor (agents/kinds.js
 * keeps 'money' out of what may be always allowed), and the payment is made at approval time with the person's own
 * token (agents/spend.js). A run that asks over what is left of the agent's weekly allowance is refused before the
 * person ever sees it.
 *
 * The tool is only offered to an agent whose person set a weekly allowance on its page (ctx.spend, read by the engine
 * from the agent that owns the run). With no allowance there is nothing to offer.
 */

const spend = require('../../agents/spend');

module.exports = {
    name: 'spend_vibes',
    description: 'Tip a creator on OpenVibe with your person\'s Vibes. The tip is not paid here: it goes to your person '
        + 'as an approval, and they pay it themselves with their own Vibes. Name the creator by their OpenVibe account '
        + 'id (usr_…, a person on OpenVibe) or by their OpenVibe page name (a channel). Say why, in one short line: '
        + 'your person reads it on the card. The tip may not be more than what is left of your weekly allowance.',
    input: {
        type: 'object',
        properties: {
            to: { type: 'string', description: 'The creator: their OpenVibe account id (usr_…) or their OpenVibe page name (a channel).' },
            amount: { type: 'integer', minimum: 1, description: 'How many whole Vibes to send.' },
            reason: { type: 'string', maxLength: 300, description: 'Why the tip is sent, in one short line: your person reads it before they pay.' },
        },
        required: ['to', 'amount'],
    },
    scope: 'person',
    acts: true,
    costUsd: 0,
    timeoutMs: 20_000,

    /** Only an agent with a weekly allowance of its own, on a server that can pay it, is offered this tool. */
    available(ctx) {
        const s = ctx && ctx.spend ? ctx.spend : null;
        const billing = ctx && ctx.config && ctx.config.services ? ctx.config.services.billingUrl : '';
        // A chat has its own consent card, not the approval floor; money is only offered behind the floor.
        return !!(s && Number(s.weekly) > 0 && billing && !ctx.chatPolicy);
    },

    /**
     * Nothing is paid here, ever. The approval gate above stops the call with the person's card; if it somehow did
     * not, this repeats the allowance check and says plainly that no tip was sent, so a run can never spend by
     * another path.
     */
    async run(input, ctx) {
        const owner = String((ctx && ctx.requester) || '');
        const agentId = ctx && ctx.spend ? ctx.spend.agent_id : null;
        const amount = Number(input && input.amount);
        if (!agentId) return { text: 'This agent may not spend: it has no allowance of its own. Ask your person to set one on the agent\'s page.', isError: true };
        const left = await spend.check(ctx.store, { owner, agentId, amount }).catch(() => null);
        if (!left || !left.ok) {
            return { text: (left && left.message) || 'This agent may not spend that.', isError: true };
        }
        return {
            text: 'No tip was sent: a tip is only paid when your person approves it on their approvals page.',
            data: { asked: false, amount, to: String(input.to || '') },
            isError: true,
        };
    },
};
