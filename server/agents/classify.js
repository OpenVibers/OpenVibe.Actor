'use strict';

/**
 * What kind of task this is, so the router knows what an agent must be able to do (a hard requirement, ADR-044 §4):
 *
 *   code      write, fix or review code                         → task:code
 *   web       needs a live web search (recent, prices, news)    → task:web
 *   lookup    facts about a domain, address or site             → task:lookup
 *   research  read the pages it names, or OpenVibe's content    → task:research
 *   answer    write or explain from what a model knows          → task:answer
 *
 * heuristic(task) is free and is what private mode and the public dry run use. classify() asks a cheap model when one
 * is configured, and falls back to the heuristic on any failure; its cost is part of the task's.
 */

const CLASSES = ['answer', 'lookup', 'research', 'web', 'code'];

const CODE = /\b(code|function|bug|stack ?trace|refactor|unit tests?|pull request|repo(sitory)?|compile|typescript|javascript|python|golang|rust|java|sql query|regex|script|api endpoint|implement)\b|```/i;
const LOOKUP = /\b(dns|mx|spf|dkim|dmarc|whois|rdap|nameservers?|ssl|tls|certificate|headers?|redirects?|ip address|asn|geoip|reverse dns|ptr|ttl|robots\.txt|sitemap|uptime|ping|traceroute|port \d+|hosting provider|registrar)\b/i;
const DOMAINISH = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b|\b\d{1,3}(?:\.\d{1,3}){3}\b/i;
const WEB = /\b(latest|today|tonight|yesterday|this week|this month|current(ly)?|right now|news|price of|stock|weather|score|election|released?|recent(ly)?|202\d|trending|search the web|look up online|compare prices)\b/i;
const URL = /https?:\/\/\S+/i;
const RESEARCH = /\b(summari[sz]e|read|according to|sources?|cite|citations?|brief|report on|research)\b/i;

function heuristic(task) {
    const t = String(task || '');
    if (CODE.test(t)) return 'code';
    if (LOOKUP.test(t) && DOMAINISH.test(t)) return 'lookup';
    if (URL.test(t)) return 'research';
    if (WEB.test(t)) return 'web';
    if (RESEARCH.test(t)) return 'web';
    return 'answer';
}

const SYSTEM = `You sort one task for an agent router. Reply with JSON only: {"class": "<one of answer|lookup|research|web|code>"}.
answer: writing, explaining, advice, maths, anything a capable model can do from what it knows.
lookup: facts about a specific domain, website, IP address or server (DNS, mail records, certificates, headers, ownership, robots.txt).
research: read the specific web pages it links to, or OpenVibe's own content, and report.
web: needs searching the live web: anything recent or changing (news, prices, releases, schedules, people's current roles).
code: write, change, debug or review code.`;

/**
 * classify(task, { chat }) → { class, cost_usd, by }. `chat` is a provider client (server/agents/providers.js) or
 * null; without one, or when it fails, the heuristic decides.
 */
async function classify(task, { chat = null, signal } = {}) {
    const guess = heuristic(task);
    if (!chat) return { class: guess, cost_usd: 0, by: 'heuristic' };
    try {
        const r = await chat({
            messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: String(task).slice(0, 4000) }],
            json: true, maxTokens: 30, signal,
        });
        const parsed = JSON.parse(String(r.text || '').trim().replace(/^```(?:json)?|```$/g, ''));
        const cls = CLASSES.includes(parsed.class) ? parsed.class : guess;
        return { class: cls, cost_usd: r.cost_usd || 0, by: 'model' };
    } catch {
        return { class: guess, cost_usd: 0, by: 'heuristic' };
    }
}

const requirementFor = (cls) => `task:${CLASSES.includes(cls) ? cls : 'answer'}`;

module.exports = { classify, heuristic, requirementFor, CLASSES };
