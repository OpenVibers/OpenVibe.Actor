'use strict';
module.exports = {
    name: 'ask_person',
    description: 'Ask your person a question, or ask them to do one step themselves. The goal saves its place and rests until they answer. Never ask for passwords or payment details.',
    input: { type: 'object', additionalProperties: false, required: ['kind', 'text'], properties: {
        kind: { type: 'string', enum: ['answer_question', 'do_yourself'] }, text: { type: 'string', maxLength: 2000 },
        options: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 200 } },
    } },
    scope: 'person', acts: false, costUsd: 0, timeoutMs: 30000,
    available: (ctx) => Boolean(ctx.day),
    async run(input, ctx) { return ctx.day.ask(ctx.taskId, input); },
};
