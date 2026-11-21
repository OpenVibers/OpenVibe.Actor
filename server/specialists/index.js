'use strict';

/**
 * Specialists (plan §AD.25; the owner, 2026-11-17: "create a Design bot as a default next to Actor and Codes which is
 * interconnected with all our design tools and features"): Actor's own agent loop with a craft's brief and that craft's
 * tools, never a second engine. A task names one on its engine ({ kind: 'agent', specialist: 'design' }); a group's
 * Design member is one, and it answers anyone in the group (it is no one's installed agent).
 *
 *   design   openvibe.design's eye and hands:
 *              knows   the rules register (openvibe.design/rules), one line a rule, read at the start of every turn,
 *                      and design_rules for any rule's detail and why
 *              hands   Design's public MCP tools (themes and tokens, components, icons, fonts, typefaces, vectors)
 *              eyes    Vision's UI check (vision_check_ui: layout, cut-off text, overlap and contrast from a page's HTML or
 *                      URL; free and anonymous), beside Design's markup audit (plan §AD.25; the owner, 11-17:
 *                      "Interconnect openvibe.vision with openvibe.design and codes and actor"). Vision's paid review
 *                      panel comes when Actor can name the person to Vision (a service grant), never on Actor's account
 *              reviews a page or a change as a phone and a desktop see it, light and dark, held to the rules; in a
 *                      group's review it ends with APPROVED, or a CHANGES line and a numbered list
 *
 *   createSpecialists({ config, log, guard, now, listTools?, callTool?, fetchJson? })
 *     .known(name)                      → is it a specialist
 *     .brief(name)                      → the words added to the loop's system message ('' when unknown)
 *     .tools(name)                      → { definitions, byAlias }: the loop's dynamic tools for it
 *
 * Design's MCP tool list and its rules are read over the egress guard and kept ten minutes; when Design does not
 * answer, the specialist still runs on the brief it last had (or the built-in one) with design_rules saying so.
 */

const mcp = require('../connections/mcp');
const guarded = require('../net/guarded-request');

const { SPECIALISTS } = require('./names');
const KEEP_MS = 10 * 60 * 1000;
// The rule areas that are about how things look and behave (the others, products and building, are not a reviewer's).
const DESIGN_AREAS = ['honest', 'length', 'motion', 'navigation', 'phone', 'words', 'look', 'agents'];

// The brief is a process, not only rules (2026-11-17, the owner sent Stageshow, a design skill whose worth is its
// workflow: plan before building, start from the best existing example, design both widths, prove the still, check
// with a machine before judging with an eye, review from the result alone). The words below are OpenVibe's own.
const DESIGN_BRIEF = [
    'You are Design, OpenVibe\'s designer (openvibe.design). You look at interfaces as a person on a phone and on a desktop sees them, hold them to OpenVibe\'s design rules, and make what a design needs: icons, themes and tokens, a type scale, a component spec, a page.',
    '',
    // 2026-11-21 (the owner, of a group's "Test": a minute of tools, then "Working — …", a handover and evidence marks):
    // the size of the answer follows the size of the ask.
    'Size the answer to the message. A greeting, a test or a vague message gets one or two friendly lines: what you can do and what to send you (a page address, a screenshot, a component to make). No tools, no plan, no handover, no review. Never begin with "Working". The process below is for real design work; the handover note only when you made or changed something.',
    '',
    'When you make or change something, most of the quality is decided before any code, so plan it first, in a few lines:',
    '1. Place: where it is seen (a page, a sheet, a card, a phone column), at what width, on what ground. Design at the size it is seen. A phone layout is designed again at 390 px, never the desktop one squeezed.',
    '2. The one job: what the person came for, the one thing that happens or must be found first, and what is left out. One primary action a view.',
    '3. Start from the best of ours: the closest OpenVibe component or pattern (openvibe_design_list_components, openvibe_design_get_component, the rules\' "see" links). Keep its structure and sizes; change the content. Never start from a blank page or from another product\'s look.',
    '4. Words: count the real strings and keep them few; plain words about the person. Tokens for every colour, defined for light and dark; OpenVibe\'s glyphs (openvibe_design_icon_search), never another icon set.',
    '5. The still first: the resting state (and the reduced-motion frame) must tell the whole story alone. Then motion, and only motion with a cause.',
    '6. Check with a machine before judging with an eye: run openvibe_design_audit_page on the page (and Link\'s screenshots at 390 and 1280 px, dark and light, when you have them). A finding it reports is never "intentional": fix the cause.',
    '7. Hand over with a note: the component you started from, what you changed, what you checked, and what you did not check.',
    '',
    'When you review a page or a change, judge the result, not the reasons:',
    '1. Look at it as it is: draw it with computer_page_check on one of the person\'s computers when one is online (a phone and a desktop, dark and light: what sticks out, small targets and text, and what each picture shows), audit its markup (openvibe_design_audit_page), read the markup and styles that changed, look at the screenshots in the conversation or the shared space. The builder\'s plan and explanations are not evidence; the page is.',
    '2. Your first question: does it answer this product and this page, or could it be any product\'s? Put it beside the closest OpenVibe component or pattern and say the one difference.',
    '3. Hold it to the checklist: nothing sticks out sideways; touch targets at least 44 px; text at least 12 px (body 14 to 16); no native select, checkbox, radio or file button showing; no "Load more" button under a list that can load itself; icons fill their place (about 20 px beside words, centred); loading uses the OpenVibe mark, never a borrowed spinner; empty, error and partial states say what to do next; colours come from the theme\'s tokens, defined for both themes; motion follows the person\'s motion setting; one primary action per view; plain words about the person, no codenames or internal states.',
    '4. Hold it to the rules below, by their ids. Say which rule a finding breaks.',
    '5. Rank what you find by how much of the page it spoils, not by how easy it is to fix: the layout and framing first, then hierarchy and density, then motion, then polish. Each finding: where it is (the page, the element, the width and theme), the evidence (the audit line, the element, the screenshot), and the fix in one line. Say what works too, briefly, and say what you could not check.',
    'Use your tools: design_rules for a rule\'s detail and why; openvibe_design_audit_page to check a page\'s markup; vision_check_ui to check its layout, cut-off text, overlap and contrast (OpenVibe.Vision); openvibe_design_* for themes, tokens, components, icons, fonts and vectors. Never invent a rule, a token or an icon name: look it up.',
    'Never copy another product\'s design. Prefer OpenVibe\'s own components, glyphs and tokens to anything new.',
].join('\n');

const lineOf = (r) => `- ${r.id}: ${String(r.rule || '').replace(/\s+/g, ' ').trim()}`;

function createSpecialists({ config = {}, log = console, guard = {}, now = () => Date.now(), listTools = null, callTool = null, fetchJson = null } = {}) {
    const cfg = config.specialists || {};
    const designMcp = cfg.designMcpUrl || 'https://openvibe.design/mcp';
    const designRules = cfg.designRulesUrl || 'https://openvibe.design/api/v1/rules';
    const guardOpts = () => ({ lookup: guard.lookup, isAllowed: guard.isAllowed, ports: guard.ports });
    const list = listTools || ((conn, opts) => mcp.listTools(conn, opts));
    const call = callTool || ((conn, name, args, opts) => mcp.callTool(conn, name, args, opts));
    const getJson = fetchJson || ((url) => guarded.json(url, { timeoutMs: 8000, maxBytes: 2 * 1024 * 1024, ...guardOpts() }));
    const conn = { id: 'design', name: 'OpenVibe.Design', url: designMcp };
    // The servers whose tools the specialist holds: each its own MCP endpoint and the tools it may use there.
    const SERVERS = [
        { conn, site: 'https://openvibe.design', label: 'Design', take: (t) => /^[a-z][a-z0-9_]{1,63}$/.test(t.name) },
        { conn: { id: 'vision', name: 'OpenVibe.Vision', url: cfg.visionMcpUrl || 'https://openvibe.vision/mcp' }, site: 'https://openvibe.vision', label: 'Vision', take: (t) => t.name === 'vision.check_ui' },
    ];
    // What was read and when; a failed read waits a minute before the next try (never on every turn).
    const kept = { rules: null, rulesAt: 0, rulesFailed: 0, tools: null, toolsAt: 0, toolsFailed: 0 };
    const RETRY_MS = 60 * 1000;

    async function rules() {
        if (kept.rules && now() - kept.rulesAt < KEEP_MS) return kept.rules;
        if (kept.rulesFailed && now() - kept.rulesFailed < RETRY_MS) return kept.rules;
        try {
            const d = await getJson(designRules);
            const all = d && Array.isArray(d.rules) ? d.rules.filter((r) => r && typeof r.id === 'string' && r.rule) : [];
            if (all.length) { kept.rules = { all, updated: String((d && d.updated) || '').slice(0, 10) }; kept.rulesAt = now(); kept.rulesFailed = 0; }
        } catch (err) {
            if (log && log.warn) log.warn(`[Actor] Design's rules did not come: ${(err && err.message) || err}`);
            kept.rulesFailed = now();
        }
        return kept.rules;
    }

    async function mcpTools() {
        if (kept.tools && now() - kept.toolsAt < KEEP_MS) return kept.tools;
        if (kept.toolsFailed && now() - kept.toolsFailed < RETRY_MS) return kept.tools || [];
        // Each server alone: one that does not answer leaves the others' tools in place.
        const got = await Promise.all(SERVERS.map(async (sv) => {
            try {
                const tools = await list(sv.conn, { timeoutMs: 8000, ...guardOpts() });
                return (Array.isArray(tools) ? tools : []).filter((t) => t && typeof t.name === 'string' && sv.take(t)).slice(0, 40).map((t) => ({ ...t, server: sv }));
            } catch (err) {
                if (log && log.warn) log.warn(`[Actor] ${sv.conn.name}'s tools did not come: ${(err && err.message) || err}`);
                return null;
            }
        }));
        if (got.every((x) => x === null)) { kept.toolsFailed = now(); return kept.tools || []; }
        kept.tools = got.flatMap((x) => x || []); kept.toolsAt = now(); kept.toolsFailed = 0;
        return kept.tools;
    }

    const known = (name) => SPECIALISTS.includes(name);

    async function brief(name) {
        if (name !== 'design') return '';
        const r = await rules();
        const lines = [DESIGN_BRIEF];
        if (r) {
            const mine = r.all.filter((x) => DESIGN_AREAS.includes(x.area));
            lines.push('', `OpenVibe's design rules (${mine.length} of ${r.all.length}, updated ${r.updated || 'recently'}; https://openvibe.design/rules):`, ...mine.slice(0, 220).map(lineOf));
        } else {
            lines.push('', 'The rules register did not answer just now: hold the work to the checklist above, and say the rules were not checked.');
        }
        return lines.join('\n');
    }

    /** The rules tool: a rule's detail, why and links, by id or by words. */
    const rulesModule = {
        name: 'design_rules', alias: 'design_rules', display: 'Design · rules',
        description: 'Look up OpenVibe\'s design rules (openvibe.design/rules): by id ("no-fake-content"), or by words ("touch targets", "loading"). Answers each rule with its detail, why it was decided and its page.',
        input: { type: 'object', properties: { query: { type: 'string', description: 'a rule id, or words to find rules by' } }, required: ['query'] },
        scope: 'public', acts: false, costUsd: 0, timeoutMs: 10000,
        async run(input) {
            const r = await rules();
            if (!r) return { text: JSON.stringify({ error: 'the rules register did not answer just now' }), isError: true };
            const q = String((input && input.query) || '').toLowerCase().trim();
            const exact = r.all.find((x) => x.id === q);
            const words = q.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
            const score = (x) => { const hay = `${x.id} ${x.rule} ${x.detail || ''}`.toLowerCase(); return words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0); };
            const hits = exact ? [exact] : r.all.map((x) => [x, score(x)]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([x]) => x);
            return {
                text: JSON.stringify({ rules: hits.map((x) => ({ id: x.id, area: x.area, rule: x.rule, detail: x.detail || null, why: x.why || null, decided: x.decided || null, url: x.url || null })) }).slice(0, 12000),
                sources: hits.slice(0, 3).map((x) => ({ url: x.url || 'https://openvibe.design/rules', title: `Rule ${x.id}` })),
                isError: false,
            };
        },
    };

    function mcpModule(tool) {
        const sv = tool.server || SERVERS[0];
        // A model calls a tool by a name of letters, digits and _ ("vision.check_ui" is vision_check_ui).
        const alias = tool.name.replace(/[^A-Za-z0-9_]/g, '_');
        return {
            name: `${sv.conn.id}:${tool.name}`, alias, display: `${sv.label} · ${tool.name.replace(/^openvibe_design_|^vision\./, '').replace(/_/g, ' ')}`,
            description: `A tool of ${sv.conn.name}.\n\ndescription from ${sv.conn.name}:\n\`\`\`\n${String(tool.description || '').slice(0, 1500)}\n\`\`\``,
            input: tool.inputSchema && tool.inputSchema.type === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
            scope: 'public',
            acts: !(tool.annotations && tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint !== true) && /make|draft|create|edit|migrate/.test(tool.name),
            costUsd: 0, timeoutMs: 20000,
            async run(input) {
                try {
                    const out = await call(sv.conn, tool.name, input || {}, { timeoutMs: 20000, ...guardOpts() });
                    return { text: String((out && out.text) || '').slice(0, 64 * 1024), sources: [{ url: sv.site, title: `${sv.conn.name} · ${tool.name}` }], isError: !!(out && out.isError) };
                } catch (err) {
                    throw new Error(`${sv.conn.name} did not answer: ${String((err && err.message) || err).slice(0, 200)}`);
                }
            },
        };
    }

    async function tools(name) {
        const empty = { definitions: [], byAlias: new Map() };
        if (name !== 'design') return empty;
        const modules = [rulesModule, ...(await mcpTools()).map(mcpModule)];
        return {
            definitions: modules.map((m) => ({ type: 'function', function: { name: m.alias, description: m.description, parameters: m.input } })),
            byAlias: new Map(modules.map((m) => [m.alias, m])),
        };
    }

    return { known, brief, tools, SPECIALISTS };
}

module.exports = { createSpecialists, SPECIALISTS, DESIGN_AREAS };
