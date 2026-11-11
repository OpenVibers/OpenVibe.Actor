'use strict';

const READ = ['calculate', 'convert_time', 'currency_convert', 'geocode', 'market_quote', 'place_info',
    'read_page', 'recall', 'search_openvibe', 'search_web', 'sports_scores', 'time_in', 'weather_now', 'wikipedia'];
const WORK = [...READ, 'make_file', 'make_chart', 'remember', 'ask_person', 'wait_for'];
const DESK = ['computer_desk', 'computer_browser', 'computer_input', 'computer_screen', 'computer_list',
    'computer_read', 'computer_write', 'computer_run', 'muse_run', 'list_my_computers', 'hand_to_person'];
const lane = (asks, tools, minutes = 20) => ({ asks_before: asks, tools, budget: { usd: 0.25, minutes } });
const LANES = Object.freeze({
    find_work: lane(['applying', 'answering_employers', 'signing_up'], [...WORK, ...DESK]),
    earn_gig: lane(['publishing', 'quoting', 'accepting_orders', 'payouts', 'signing_up'], [...WORK, ...DESK]),
    grow_channel: lane(['posting', 'signing_up'], [...WORK, ...DESK]),
    brief_me: lane([], WORK, 10),
    watch_deals: lane(['buying'], WORK, 10),
    build_it: lane(['deploying', 'spending_above_cap'], [...WORK, 'codes_task']),
    inbox_zero: lane(['sending'], [...WORK, ...DESK]),
    custom: lane(['spending', 'posting', 'applying', 'signing_up', 'messaging'], [...WORK, ...DESK, 'codes_task']),
});
// These write only this run's work. Every other action in a day run needs its own exact approval.
const LOCAL = new Set(['make_file', 'make_chart', 'remember', 'ask_person', 'wait_for']);
module.exports = { LANES, LOCAL, DESK };
