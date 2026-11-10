'use strict';

/**
 * The six agent.report@1 states, as data for the panel (plan W1/W9, S5). A report is the executor's own account of a
 * Ticket; a ticket stage is computed from the latest report by the first matching row of agent.stage@1. The states are
 * closed: an executor that wants another word is asking for a contract change, not a new string.
 *
 *   REPORT_STATES       [{state, label, meaning}] in contract order
 *   REPORT_STATE_VALUES the six values alone (for checks and counts)
 *   REPORT_STAGES       the stage each state leaves on an open Ticket
 *   reportStates()      a copy for an API response
 *   emptyReportCounts() all six at zero, for a lane's per-state summary
 */
const REPORT_STATES = Object.freeze([
    { state: 'progress', label: 'Working', meaning: 'The executor is working on the Ticket.' },
    { state: 'waiting', label: 'Waiting', meaning: 'The executor is waiting for a trigger or an event.' },
    { state: 'ready', label: 'Ready for review', meaning: 'The work is done and ready for the owner to review.' },
    { state: 'blocked', label: 'Blocked', meaning: 'The executor cannot continue without a person.' },
    { state: 'failed', label: 'Failed', meaning: 'The last run failed.' },
    { state: 'dropped', label: 'Dropped', meaning: 'The work was stopped or dropped and will not continue.' },
]);
const REPORT_STATE_VALUES = Object.freeze(REPORT_STATES.map((s) => s.state));
const REPORT_STAGES = Object.freeze({ ready: 'person/review', blocked: 'person/blocked', failed: 'person/failed', waiting: 'idle', progress: 'working', dropped: 'idle' });

const reportStates = () => REPORT_STATES.map((s) => ({ ...s }));
const emptyReportCounts = () => Object.fromEntries(REPORT_STATE_VALUES.map((s) => [s, 0]));

module.exports = { REPORT_STATES, REPORT_STATE_VALUES, REPORT_STAGES, reportStates, emptyReportCounts };
