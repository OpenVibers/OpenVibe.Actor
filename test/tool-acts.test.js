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
    ask_person: false,
    ask_location: true,
    ask_photo: true,
    // Read-only: they only read what is already there, so a resume may run them again.
    calculate: false,
    canvas_set: false,
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
    locker_fill_login: false,
    setup_save_key: true,
    market_quote: false,
    place_info: false,
    read_page: false,
    decide: false,
    read_pages: false,
    fetch_data: false,
    recall: false,
    search_openvibe: false,
    openvibe_updates: false,
    search_web: false,
    sports_scores: false,
    time_in: false,
    video_analyze: false,
    my_apps_search: false,   // plan §L.2: the tools in the person's own apps, through Connect
    script_run: false,   // plan §AD.26 item 6: a program on Run with no network, no files and no tools: it changes nothing
    weather_now: false,
    wikipedia: false,
    // Acting: a robot moves, a command runs, a file or memory is written, a task or hand-off starts, or a generic
    // OpenVibe.Tools tool may do any of those.
    codes_task: true,
    my_apps_run: true,   // a script over the person's apps: with a write grant it may change something
    computer_browser: true,
    computer_page_check: true,   // plan §AD.25: it opens a page in the agent's browser, as computer_browser open does
    computer_desk: true,
    computer_input: true,
    computer_run: true,
    computer_write: true,
    hand_to_person: true,
    learn_from_person: true,   // a lesson: it waits for the person and writes a skill draft (Teach, plan §AD.33)
    learn_from_words: false,
    spare_usage: true,   // changes the person's spare-usage list on Codes (what it holds starts tasks)   // a lesson told in words: it only writes a skill draft the person keeps or not
    // A wait changes nothing in the world: it parks the run until the event or the deadline.
    wait_for: false,
    make_chart: true,
    make_file: true,
    // A Muse step runs an agent on the person's computer, which reads, changes and runs things there.
    muse_run: true,
    notify_phone: true,
    remember: true,
    robot_steps: true,
    run_tool: true,
    schedule_trigger: true,
    // A web watch keeps running after the turn: one search a day for the person (plan AD.34 item 6).
    watch_web: true,
    // Space: the agent builds the person's own spaces (plan 2026-10-22 §Z stage Z1). Making one, writing its files
    // and asking to publish it change the world; listing and reading them do not.
    space_create: true,
    git_repos_list: false,
    git_repo_create: true,
    git_files_write: true,
    git_change_open: true,
    space_files_list: false,
    space_files_read: false,
    space_files_write: true,
    space_preview: false,
    space_publish: true,
    space_site_from_repo: true,
    // Money (plan HO7): a tip asks the person, and the payment moves their Vibes when they approve it.
    spend_vibes: true,
    // Files (the person's own drive, OpenVibe.Download): listing and reading change nothing; saving a file does.
    files_list: false,
    files_read: false,
    files_save: true,
    // Mail (OpenVibe.Mail): reading the person's inbox changes nothing, and a draft is a draft: the person sends it.
    email_list: false,
    email_read: false,
    email_draft: false,
    // A check on a shared node (OpenVibe.Run) starts work on somebody's machine: it acts.
    shared_node_check: true,
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
