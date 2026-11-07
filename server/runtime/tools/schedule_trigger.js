'use strict';
/**
 * A trigger made in the conversation (plan §12 A-4, HO3, HO4): "every weekday at 9, summarise my inbox", "when a
 * new issue lands in my repo, triage it", or "keep checking the price of X every 30 minutes until it drops
 * under €120, then tell me" — a goal that keeps going until its own check passes.
 *
 * The sentence is parsed here, deterministically. When it is ambiguous (no time, no timezone, two times, "every
 * so often", no event it can name, an "until" no run can check) the tool creates nothing and returns the one
 * question to ask in plain words. When it is clear, the subscription is created in OpenVibe.Watch with the
 * person's own token, linked to this thread, and the card goes onto the turn as a trigger step. The model may
 * also pass the fields explicitly (`cron`, `timezone`, `task`, `event`, `goal`) after the person answered.
 *
 * A goal (kind goal) carries the goal in words, the done-test each run answers yes or no, and its limits: runs,
 * money and a deadline. Its runs post their answers in this chat (unless the person switches that off).
 */
const { personOf } = require('./_openvibe');
const contacts = require('../../agents/contacts');
const { parseRequest, wordsFor } = require('../../triggers/parse');
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
    description: 'Make something run on a schedule, when an OpenVibe event happens, or keep working toward a goal until it is done: "every weekday at 9, summarise my inbox", "when a new issue lands in my repo, triage it", or "keep checking the price of the Framework 13 every 30 minutes until it drops under €120, then tell me". It parses the sentence, creates the Watch subscription as the person, and puts a live trigger card on this thread. If the request is ambiguous it creates nothing and tells you the one question to ask them first (the time, the timezone, what event, what to do, or — for a goal — the check that says it is done). A goal ends itself when its check passes, or when its runs, money or deadline is spent, and each run posts its answer in this chat. Money, passwords, deletions and new recipients still always ask when the trigger runs.',
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
            goal: {
                type: 'object',
                description: 'A goal to keep working toward, when the person asked for one ("until …"). Give it when the sentence did not parse into one after you asked, or to set its limits.',
                properties: {
                    text: { type: 'string', description: 'The goal in the person\'s words.' },
                    done_test: { type: 'string', description: 'The check a run answers yes or no, such as "the price is under €120" or "the tests pass".' },
                    runs_max: { type: 'integer', description: 'The most runs allowed (default 12).' },
                    budget_usd: { type: 'number', description: 'The most its runs may spend (default: the person\'s daily allowance).' },
                    deadline_at: { type: 'string', description: 'A date-time after which the goal ends (default: seven days).' },
                },
                required: ['text', 'done_test'],
            },
            notify: { type: 'boolean', description: 'Also tell the person through OpenVibe\'s notifications when a run finishes. Default: only when their sentence asked to be told.' },
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
        const explicitGoal = input.goal && typeof input.goal === 'object' && String(input.goal.text || '').trim() && String(input.goal.done_test || '').trim() ? input.goal : null;
        const timezone = String(input.timezone || ctx.timezone || '').trim();

        let parsed;
        if (explicitCron || explicitEvent || explicitGoal) {
            const kind = explicitGoal ? 'goal' : explicitCron ? 'schedule' : 'event';
            const task = String(input.task || said || '').trim();
            if (!task) return { text: 'Before I make it: what should I do each time?', data: { question: 'What should I do each time?' } };
            if (kind !== 'event') {
                if (!timezone || !cron.isZone(timezone)) return { text: 'Before I make it: which timezone should the schedule use? (For example Europe/Berlin.)', data: { question: 'Which timezone?' } };
                const expr = explicitCron || '*/15 * * * *';
                const verdict = cron.validate(expr, timezone);
                if (!verdict.valid) return { text: `That schedule cannot run: ${verdict.error}. What time should it run?`, data: { question: `That schedule cannot run: ${verdict.error}. What time should it run?` } };
                parsed = {
                    status: 'ok', kind, cron: expr, timezone, task, words: wordsFor(expr, timezone),
                    ...(explicitGoal ? { goal: { text: String(explicitGoal.text).trim(), done_test: String(explicitGoal.done_test).trim(), runs_max: explicitGoal.runs_max, budget_usd: explicitGoal.budget_usd, deadline_at: explicitGoal.deadline_at } } : {}),
                    tell: false,
                };
            } else {
                parsed = { status: 'ok', kind, task, event: { pattern: input.event.pattern, filter: input.event.filter || null }, words: `When ${input.event.pattern}`, tell: false };
            }
        } else {
            parsed = parseRequest(said, { timezone: timezone || null, task: input.task || null });
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

        const notify = input.notify === true || (input.notify === undefined && parsed.tell === true);
        const out = await ctx.triggers.create({
            owner, agentId, task: parsed.task,
            kind: parsed.kind,
            cron: parsed.cron || null,
            timezone: parsed.timezone || null,
            event: parsed.event || null,
            goal: parsed.goal || null,
            level: ctx.level || 'ask',
            turnTaskId: ctx.taskId || null,
            personToken: ctx.personToken || null,
            announce: false,
            notify,
        });
        if (out.error) {
            return {
                text: JSON.stringify({ error: out.error.detail, code: out.error.code, ...(out.error.code === 'actor.trigger.sign_in' ? { needs_you: true } : {}) }),
                data: out.error, isError: true,
            };
        }
        const card = out.trigger;
        const goal = card.goal ? ` It ends when ${card.goal.done_test}, or after ${card.goal.runs_max} runs${card.goal.deadline_at ? ` or on ${String(card.goal.deadline_at).slice(0, 10)}` : ''}.` : '';
        const line = `It is on: ${card.when.words}. ${clip(card.task, 160)}${card.next_run_at ? ` Next run ${card.next_run_at}.` : ''}${goal}${notify ? ' I will tell you when a run finishes.' : ''}`;
        if (ctx.emit) await ctx.emit({ step: 'trigger', text: line, trigger: card });
        return { text: line, data: { trigger: card } };
    },
};
