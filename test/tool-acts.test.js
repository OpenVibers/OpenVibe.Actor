'use strict';
/**
 * Every tool decides whether it acts (Actor v2, stage V2-9): `acts: true` means it writes, sends, starts or moves
 * something outside the model's own reasoning, so a checkpoint must pause a resume before it runs again. This list is
 * the whole registry: a new tool fails here until it is classified, and a classification that changes is reviewed.
 */
const assert = require('assert');
const { createRegistry } = require('../server/runtime/tools');
const { check, done } = require('./helpers/boot');

const EXPECTED = {
    // Read-only: they only read what is already there, so a resume may run them again.
    calculate: false,
    convert_time: false,
    currency_convert: false,
    computer_list: false,
    computer_read: false,
    computer_screen: false,
    find_tools: false,
    geocode: false,
    load_skill: false,
    list_my_computers: false,
    list_my_robots: false,
    market_quote: false,
    place_info: false,
    read_page: false,
    recall: false,
    search_openvibe: false,
    search_web: false,
    sports_scores: false,
    time_in: false,
    weather_now: false,
    wikipedia: false,
    // Acting: a robot moves, a command runs, a file or memory is written, a task or hand-off starts, or a generic
    // OpenVibe.Tools tool may do any of those.
    codes_task: true,
    computer_browser: true,
    computer_desk: true,
    computer_input: true,
    computer_run: true,
    computer_write: true,
    hand_to_person: true,
    // A wait changes nothing in the world: it parks the run until the event or the deadline.
    wait_for: false,
    make_chart: true,
    make_file: true,
    remember: true,
    robot_steps: true,
    run_tool: true,
    schedule_trigger: true,
    // Space: the agent builds the person's own spaces (plan 2026-10-22 §Z stage Z1). Making one, writing its files
    // and asking to publish it change the world; listing and reading them do not.
    space_create: true,
    space_files_list: false,
    space_files_read: false,
    space_files_write: true,
    space_preview: false,
    space_publish: true,
    // Money (plan HO7): a tip asks the person, and the payment moves their Vibes when they approve it.
    spend_vibes: true,
};

(async () => {
    await check('every tool says whether it acts, and only the acting ones say true', async () => {
        const registry = createRegistry({ strict: true, log: { warn() {}, log() {} } });
        assert.deepStrictEqual(registry.errors, [], 'every module loads');
        const names = registry.tools.map((t) => t.name).sort();
        assert.deepStrictEqual(names, Object.keys(EXPECTED).sort(), 'the list covers every tool; classify a new one');
        for (const tool of registry.tools) {
            assert.strictEqual(tool.acts === true, EXPECTED[tool.name], `${tool.name}: acts must be true exactly when it acts`);
        }
        const acting = registry.tools.filter((t) => t.acts === true).map((t) => t.name).sort();
        assert.deepStrictEqual(acting, Object.keys(EXPECTED).filter((n) => EXPECTED[n]).sort());
        process.stdout.write(`  ✓ ${registry.tools.length} tools: ${acting.length} act (${acting.join(', ')})\n`);
    });
    done();
})().catch((e) => { console.error(e); process.exit(1); });
