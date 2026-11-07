'use strict';
/**
 * A trigger made in the conversation (plan §12 A-4): "every weekday at 9, summarise my inbox".
 *
 * The sentence is parsed here, deterministically. When it is ambiguous (no time, no timezone, two
 * times, "every so often", no event it can name) the tool creates nothing and returns the one
 * question to ask in plain words. When it is clear, the subscription is created in OpenVibe.Watch
 * with the person's own token, linked to this thread, and the card goes onto the turn as a trigger
 * step. The model may also pass the fields explicitly (`cron`, `timezone`, `task`, `event`) after the
 * person answered.
 */
const { personOf } = require('./_openvibe');
const contacts = require('../../agents/contacts');
const { parseRequest } = require('../../triggers/parse');
const cron = require('../../triggers/cron');

const EVENT_PATTERN = /^[a-z][a-z0-9_-]*(\.[a-z0-9_*]+){1,}$/;
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** An agent the person named in the sentence, if exactly one of their agents matches its name. */
async function namedAgent(s, config, owner, text) {
    const lower = String(text || '').toLowerCase();
    const list = await contacts.list(s, config, owner).catch(() => []);
    const matches = list.filter((a) => a && a.name && lower.includes(String(a.name).toLowerCase()));
    return matches.length === 1 ? matches[0] : null;
}

module.exports = {
    name: 'schedule_trigger',
    description: 'Make something run on a schedule or when an OpenVibe event happens: "every weekday at 9, summarise my inbox" or "when a new issue lands in my repo, triage it". It parses the sentence, creates the Watch subscription as the person, and puts a live trigger card on this thread. If the request is ambiguous it creates nothing and tells you the one question to ask them first (the time, the timezone, what event, or what to do). Money, passwords, deletions and new recipients still always ask when the trigger runs.',
    scope: 'person',
    acts: true,
    costUsd: 0,
    timeoutMs: 25_000,
    input: {
        type: 'object',
        properties: {
            request: { type: 'string', description: 'What the person said, in their words, including the schedule or event and the task.' },
            task: { type: 'string', description: 'The work to do each time, when the person said it separately from the schedule.' },
            agent_id: { type: 'string', description: 'Which of the person\'s agents runs it (agt_…). Default: the agent of this thread.' },
            timezone: { type: 'string', description: 'IANA timezone for a schedule (Europe/Berlin). Default: the person\'s own, when known.' },
            cron: { type: 'string', description: 'A five-field cron, when the person gave an exact schedule after you asked.' },
            event: {
                type: 'object',
                description: 'A Watch event source, when the person named one after you asked.',
                properties: {
                    pattern: { type: 'string' },
                    filter: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean', 'null'] } },
                },
                required: ['pattern'],
            },
        },
        required: [],
    },
    async run(input, ctx) {
        const owner = personOf(ctx.requester);
        if (!owner) return { text: JSON.stringify({ error: 'A trigger belongs to a signed-in person, and this run has none.' }), isError: true };
        if (!ctx.triggers) return { text: JSON.stringify({ error: 'Triggers are not configured on this Actor (OpenVibe.Watch is not connected).' }), isError: true };
        const said = String(input.request || '').trim();
        const explicitCron = typeof input.cron === 'string' && input.cron.trim() ? input.cron.trim() : null;
        const explicitEvent = input.event && typeof input.event === 'object' && EVENT_PATTERN.test(String(input.event.pattern || '')) ? input.event : null;

        let parsed;
        if (explicitCron || explicitEvent) {
            const kind = explicitCron ? 'schedule' : 'event';
            const timezone = String(input.timezone || ctx.timezone || '').trim();
            const task = String(input.task || said || '').trim();
            if (!task) return { text: 'Before I make it: what should I do each time?', data: { question: 'What should I do each time?' } };
            if (kind === 'schedule') {
                if (!timezone || !cron.isZone(timezone)) return { text: 'Before I make it: which timezone should the schedule use? (For example Europe/Berlin.)', data: { question: 'Which timezone?' } };
                const verdict = cron.validate(explicitCron, timezone);
                if (!verdict.valid) return { text: `That schedule cannot run: ${verdict.error}. What time should it run?`, data: { question: `That schedule cannot run: ${verdict.error}. What time should it run?` } };
                parsed = { status: 'ok', kind, cron: explicitCron, timezone, task, words: require('../../triggers/parse').wordsFor(explicitCron, timezone) };
            } else {
                parsed = { status: 'ok', kind, task, event: { pattern: input.event.pattern, filter: input.event.filter || null }, words: `When ${input.event.pattern}` };
            }
        } else {
            parsed = parseRequest(said, { timezone: String(input.timezone || ctx.timezone || '').trim() || null, task: input.task || null });
        }
        if (parsed.status !== 'ok') {
            return { text: `I need one thing before I make it: ${parsed.question}`, data: { needs_you: true, question: parsed.question }, sources: [] };
        }

        // Which agent runs it: the model's choice, the person's words, or this thread's own agent.
        let agentId = typeof input.agent_id === 'string' && /^agt_[0-9A-HJKMNP-TV-Z]{26}$/.test(input.agent_id) ? input.agent_id : null;
        if (!agentId && said) {
            const named = await namedAgent(ctx.store, ctx.config, owner, said);
            if (named) agentId = named.id;
        }
        if (!agentId) agentId = ctx.agentId || null;
        if (!agentId) {
            const vibe = await contacts.ensureVibe(ctx.store, ctx.config, owner).catch(() => null);
            agentId = vibe ? vibe.id : null;
        }
        if (!agentId) return { text: 'Before I make it: which of your agents should run it?', data: { question: 'Which agent?' } };

        const out = await ctx.triggers.create({
            owner, agentId, task: parsed.task,
            kind: parsed.kind,
            cron: parsed.cron || null,
            timezone: parsed.timezone || null,
            event: parsed.event || null,
            level: ctx.level || 'ask',
            turnTaskId: ctx.taskId || null,
            personToken: ctx.personToken || null,
            announce: false,
        });
        if (out.error) {
            return {
                text: JSON.stringify({ error: out.error.detail, code: out.error.code, ...(out.error.code === 'actor.trigger.sign_in' ? { needs_you: true } : {}) }),
                data: out.error, isError: true,
            };
        }
        const card = out.trigger;
        const line = `It is on: ${card.when.words}. ${clip(card.task, 160)}${card.next_run_at ? ` Next run ${card.next_run_at}.` : ''}`;
        if (ctx.emit) await ctx.emit({ step: 'trigger', text: line, trigger: card });
        return { text: line, data: { trigger: card } };
    },
};
