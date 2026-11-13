'use strict';

/**
 * Run settings and permission rules (plan 11c, §V.3).
 *
 * Two settings per run, beside the approval level the run already has (agents/levels.js: ask, auto-edits,
 * approve-for-me, full — the "approvals" setting is that level, not a second one):
 *   files    none | read | write   what the run may do with the person's own files and machines (Space files, Link
 *                                  computers, coding tasks). Default write: today's runs write through approvals,
 *                                  and a read default would silently refuse every Space page and computer task.
 *   network  off | on              whether the run may reach the open web (search engines, pages, weather and price
 *                                  services). OpenVibe's own services are the person's places, not "the network".
 * A tool module says what it needs: `needs: { files: 'none' | 'read' | 'write', network: true | false }`. A module that
 * does not say is treated as network on and files none.
 *
 * Rules are data: an ordered list, each { match: { tool?, connector?, risk?, args? }, decision, why }.
 *   tool       a tool name, `*` matches any run of characters ("computer_*")
 *   connector  a connector id (runtime/connectors.js)
 *   risk       reads | writes | sends | spends | secrets — the tool's connector's risk; a core tool reads, or writes
 *              when it acts
 *   args       { key: glob } on the call's own input, matched as text
 *   decision   allow | ask | deny
 * The LAST matching rule wins. There are two lists: the owner's (the site's), and the person's. A matching site rule
 * is final and the person's list is never read for that call; otherwise the person's last matching rule decides; no
 * match falls to the run's approval level. Nothing here ever lowers the always-ask floor (money, a password, a
 * deletion, a new recipient): an allow covers the level, never the floor (levels.decide).
 *
 * An unattended run (a schedule, a trigger Watch delivered, an agent's own routine, a run for nobody) never waits for
 * anybody: an ask leaves its card for later and the step says why it did not run.
 *
 *   SETTINGS, DEFAULTS, PRESETS
 *   needsOf(tool) → { files, network }
 *   riskOf(tool) → reads | writes | sends | spends | secrets
 *   validateSettings(x) / validateRules(list) → { value } | { error }
 *   settingsRefusal(settings, tool) → null | the plain line why the run may not use it
 *   decide(policy, { tool, args }) → null | { decision, why, source: 'site' | 'person', index }
 *   load(s, requester) / save(s, subject, patch, who)
 */

const connectors = require('./connectors');

const FILES = ['none', 'read', 'write'];
const NETWORK = ['off', 'on'];
const DECISIONS = ['allow', 'ask', 'deny'];
const RISKS = ['reads', 'writes', 'sends', 'spends', 'secrets'];
const DEFAULTS = Object.freeze({ files: 'write', network: 'on' });
const FILE_RANK = { none: 0, read: 1, write: 2 };
const MAX_RULES = 100;
const MAX_ARGS = 5;
const SITE = 'site';

// The three starter buttons (Careful, Balanced, Hands-off): each writes the person's rule list. The floor still asks
// for money, passwords, deletions and new recipients whichever is chosen.
const PRESETS = Object.freeze({
    careful: [
        { match: { risk: 'writes' }, decision: 'ask', why: 'Careful: ask before changing anything of yours.' },
        { match: { risk: 'sends' }, decision: 'ask', why: 'Careful: ask before sending anything.' },
        { match: { risk: 'spends' }, decision: 'ask', why: 'Careful: ask before spending.' },
        { match: { risk: 'secrets' }, decision: 'ask', why: 'Careful: ask before using a saved login.' },
    ],
    balanced: [
        { match: { risk: 'sends' }, decision: 'ask', why: 'Balanced: ask before sending anything.' },
        { match: { risk: 'spends' }, decision: 'ask', why: 'Balanced: ask before spending.' },
        { match: { risk: 'secrets' }, decision: 'ask', why: 'Balanced: ask before using a saved login.' },
    ],
    'hands-off': [
        { match: { risk: 'writes' }, decision: 'allow', why: 'Hands-off: changes to your things go ahead.' },
        { match: { risk: 'sends' }, decision: 'ask', why: 'Hands-off still asks before sending.' },
        { match: { risk: 'spends' }, decision: 'ask', why: 'Hands-off still asks before spending.' },
    ],
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const control = /[\u0000-\u001f\u007f]/;

/** What a tool module says it needs; a module that does not say is network on, files none. */
function needsOf(tool) {
    const n = tool && isObject(tool.needs) ? tool.needs : {};
    return {
        files: FILES.includes(n.files) ? n.files : 'none',
        network: n.network === false ? false : true,
    };
}

/** The risk of one tool: its connector's, else reads (writes when it acts). */
function riskOf(tool) {
    const c = tool && tool.connector ? connectors.get(tool.connector) : null;
    if (c && RISKS.includes(c.risk)) return c.risk;
    return tool && tool.acts === true ? 'writes' : 'reads';
}

/** The validation of a needs object on a module (the registry's validateTool). */
function needsProblems(needs) {
    if (needs == null) return [];
    if (!isObject(needs)) return ['needs: { files: none|read|write, network: true|false }'];
    const out = [];
    if (needs.files != null && !FILES.includes(needs.files)) out.push(`needs.files: one of ${FILES.join(', ')}`);
    if (needs.network != null && typeof needs.network !== 'boolean') out.push('needs.network: true or false');
    for (const k of Object.keys(needs)) if (k !== 'files' && k !== 'network') out.push(`needs.${k}: not a need (files, network)`);
    return out;
}

function validateSettings(x) {
    if (x == null) return { value: {} };
    if (!isObject(x)) return { error: 'settings is { files, network }.' };
    const value = {};
    for (const k of Object.keys(x)) {
        if (k === 'files') {
            if (x.files !== null && !FILES.includes(x.files)) return { error: `files is one of ${FILES.join(', ')}.` };
            value.files = x.files;
        } else if (k === 'network') {
            if (x.network !== null && !NETWORK.includes(x.network)) return { error: 'network is off or on.' };
            value.network = x.network;
        } else {
            return { error: `${k} is not a run setting (files, network).` };
        }
    }
    return { value };
}

/** A glob of plain text where `*` is any run of characters; at most 200 characters, no control characters. */
function validGlob(v, max = 200) {
    return typeof v === 'string' && v.length > 0 && v.length <= max && !control.test(v);
}

function validateRules(list) {
    if (!Array.isArray(list)) return { error: 'rules is a list.' };
    if (list.length > MAX_RULES) return { error: `at most ${MAX_RULES} rules.` };
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const r = list[i];
        const at = `rule ${i + 1}`;
        if (!isObject(r)) return { error: `${at} is an object { match, decision, why }.` };
        if (!DECISIONS.includes(r.decision)) return { error: `${at}: decision is allow, ask or deny.` };
        const m = r.match;
        if (!isObject(m)) return { error: `${at}: match is an object.` };
        const match = {};
        for (const k of Object.keys(m)) {
            if (k === 'tool') {
                if (!validGlob(m.tool, 64) || !/^[a-z0-9_*]+$/.test(m.tool)) return { error: `${at}: match.tool is a tool name, * for any characters.` };
                match.tool = m.tool;
            } else if (k === 'connector') {
                if (!connectors.isConnectorId(m.connector)) return { error: `${at}: match.connector is one of ${connectors.CONNECTOR_IDS.join(', ')}.` };
                match.connector = m.connector;
            } else if (k === 'risk') {
                if (!RISKS.includes(m.risk)) return { error: `${at}: match.risk is one of ${RISKS.join(', ')}.` };
                match.risk = m.risk;
            } else if (k === 'args') {
                if (!isObject(m.args)) return { error: `${at}: match.args is { key: glob }.` };
                const keys = Object.keys(m.args);
                if (!keys.length || keys.length > MAX_ARGS) return { error: `${at}: match.args names 1 to ${MAX_ARGS} keys.` };
                const args = {};
                for (const key of keys) {
                    if (!/^[A-Za-z0-9_]{1,64}$/.test(key) || !validGlob(m.args[key])) return { error: `${at}: match.args.${key.slice(0, 64)} is a glob of text.` };
                    args[key] = m.args[key];
                }
                match.args = args;
            } else {
                return { error: `${at}: match.${k.slice(0, 32)} is not a field (tool, connector, risk, args).` };
            }
        }
        if (!Object.keys(match).length) return { error: `${at}: match names at least one of tool, connector, risk, args.` };
        if (r.why != null && (typeof r.why !== 'string' || r.why.length > 200 || control.test(r.why))) return { error: `${at}: why is one line of at most 200 characters.` };
        out.push({ match, decision: r.decision, why: r.why ? r.why : null });
    }
    return { value: out };
}

function globToRegExp(glob) {
    return new RegExp(`^${glob.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's');
}

function argText(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try { return JSON.stringify(v); } catch { return ''; }
}

/** Does one rule match this call? `args` null means "the call is not known yet" (the tool list): an args rule cannot match then. */
function matches(rule, { tool, args }) {
    const m = rule.match;
    if (m.tool && !globToRegExp(m.tool).test(tool.name)) return false;
    if (m.connector && tool.connector !== m.connector) return false;
    if (m.risk && riskOf(tool) !== m.risk) return false;
    if (m.args) {
        if (args == null || !isObject(args)) return false;
        for (const [k, g] of Object.entries(m.args)) {
            if (!(k in args) || !globToRegExp(g).test(argText(args[k]))) return false;
        }
    }
    return true;
}

function lastMatch(list, call) {
    for (let i = (list || []).length - 1; i >= 0; i--) {
        if (matches(list[i], call)) return { rule: list[i], index: i };
    }
    return null;
}

/** The decision of the rules for one call: the site's last matching rule is final, then the person's. */
function decide(policy, call) {
    if (!policy || !call || !call.tool) return null;
    const site = lastMatch(policy.site, call);
    if (site) return { decision: site.rule.decision, why: site.rule.why || defaultWhy(site.rule, 'site'), source: 'site', index: site.index };
    const person = lastMatch(policy.person, call);
    if (person) return { decision: person.rule.decision, why: person.rule.why || defaultWhy(person.rule, 'person'), source: 'person', index: person.index };
    return null;
}

function defaultWhy(rule, source) {
    const whose = source === 'site' ? "this site's rules" : 'your rules';
    return rule.decision === 'deny' ? `${whose} do not allow it` : rule.decision === 'ask' ? `${whose} ask first` : `${whose} allow it`;
}

/** The run's settings refusal for one tool: null when the run may use it. */
function settingsRefusal(settings, tool) {
    if (!settings || !tool) return null;
    const need = needsOf(tool);
    if (settings.network === 'off' && need.network) return 'this run has the network off, and this tool reaches the open web';
    const have = FILE_RANK[settings.files] == null ? FILE_RANK.write : FILE_RANK[settings.files];
    if (FILE_RANK[need.files] > have) {
        return settings.files === 'none' ? 'this run may not touch your files or computers'
            : 'this run may only read your files and computers, and this tool changes them';
    }
    return null;
}

/** The words a run card shows for its settings. */
function describe(settings, level) {
    const files = { none: 'no files', read: 'reads your files', write: 'reads and changes your files' }[settings.files] || settings.files;
    const network = settings.network === 'off' ? 'network off' : 'network on';
    const asks = { ask: 'asks before it acts', 'auto-edits': 'edits go ahead, other actions ask', 'approve-for-me': 'a reviewer approves routine steps', full: 'acts without asking' }[level] || 'asks before it acts';
    return `${files} · ${network} · ${asks}${settings.unattended ? ' · unattended: nothing waits for an answer' : ''}`;
}

/** One rule in words, for the Settings page: "Asks first · changes your things — why". */
function ruleWords(rule) {
    const decision = { allow: 'Goes ahead', ask: 'Asks first', deny: 'Never runs' }[rule.decision] || rule.decision;
    const m = rule.match || {};
    const parts = [];
    if (m.risk) parts.push(`anything that ${connectors.RISK_WORDS[m.risk] || m.risk}`);
    if (m.connector) parts.push((connectors.get(m.connector) || { name: m.connector }).name);
    if (m.tool) parts.push(m.tool.includes('*') ? `tools named ${m.tool}` : `the tool ${m.tool}`);
    if (m.args) parts.push(Object.entries(m.args).map(([k, g]) => `${k} is ${g}`).join(', '));
    return { decision, what: parts.join(' · '), why: rule.why || null };
}

/** JSON with its object keys sorted: PostgreSQL's jsonb does not keep the order a rule was written in. */
function canon(v) {
    if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
    if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
    return JSON.stringify(v === undefined ? null : v);
}

/** The preset this rule list is, or null. */
function presetOf(rules) {
    const key = canon(rules || []);
    for (const [id, list] of Object.entries(PRESETS)) if (canon(validateRules(list).value) === key) return id;
    return null;
}

// ── Storage (migrations/0074_run_policy.sql) ───────────────────────────────────────────────────────────────────────
function rowOut(row) {
    if (!row) return { files: null, network: null, rules: [] };
    const rules = typeof row.rules === 'string' ? JSON.parse(row.rules || '[]') : (row.rules || []);
    return { files: row.files || null, network: row.network || null, rules: Array.isArray(rules) ? rules : [], updated_at: row.updated_at || null };
}

async function read(s, subject) {
    return rowOut(await s.db.maybe('SELECT * FROM actor_run_policies WHERE subject = $1', [subject]));
}

/**
 * The policy a run of this requester starts with: the site's rules, the person's rules and the person's default
 * settings (a task's own `settings` narrows or widens them for that run). Read per run, never cached.
 */
async function load(s, requester) {
    const site = await read(s, SITE);
    const person = typeof requester === 'string' && requester.startsWith('user:') ? await read(s, requester) : rowOut(null);
    return {
        site: site.rules,
        person: person.rules,
        defaults: { files: person.files || DEFAULTS.files, network: person.network || DEFAULTS.network },
    };
}

/** Write one subject's row: `patch` may hold files, network (null = the default) and rules (the whole ordered list). */
async function save(s, subject, patch, who) {
    const cur = await read(s, subject);
    const next = {
        files: patch.files !== undefined ? patch.files : cur.files,
        network: patch.network !== undefined ? patch.network : cur.network,
        rules: patch.rules !== undefined ? patch.rules : cur.rules,
    };
    await s.db.query(`INSERT INTO actor_run_policies (subject, files, network, rules, updated_by, updated_at)
        VALUES ($1, $2, $3, $4::jsonb, $5, $6)
        ON CONFLICT (subject) DO UPDATE SET files = EXCLUDED.files, network = EXCLUDED.network, rules = EXCLUDED.rules,
            updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
    [subject, next.files, next.network, JSON.stringify(next.rules), who || null, s.iso()]);
    return await read(s, subject);
}

/** The settings of one run: the person's defaults, the task's own settings over them, and whether it is unattended. */
function runSettings(policy, taskSettings, unattended) {
    const d = (policy && policy.defaults) || DEFAULTS;
    const t = isObject(taskSettings) ? taskSettings : {};
    return {
        files: FILES.includes(t.files) ? t.files : d.files,
        network: NETWORK.includes(t.network) ? t.network : d.network,
        unattended: unattended ? String(unattended) : null,
    };
}

module.exports = {
    FILES, NETWORK, DECISIONS, RISKS, DEFAULTS, PRESETS, MAX_RULES, SITE,
    needsOf, riskOf, needsProblems, validateSettings, validateRules, matches, decide, settingsRefusal, describe, ruleWords, presetOf,
    load, read, save, runSettings,
};
