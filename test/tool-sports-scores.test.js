'use strict';
// sports_scores: the table, the games and the team's own place in it, all from recorded answers.
const assert = require('assert');
const sports = require('../server/runtime/tools/sports_scores');
const { fixtureFetch, ctxOf } = require('./helpers/tool-fixtures');
const { check, done } = require('./helpers/boot');

const routes = {
    'www.thesportsdb.com/api/v1/json/123/lookuptable.php': (url) => (url.includes('l=4391') ? 'thesportsdb-standings-4328.json' : 'thesportsdb-standings-4328.json'),
    'www.thesportsdb.com/api/v1/json/123/eventsnextleague.php': (url) => (url.includes('id=4391') ? 'thesportsdb-nextleague-4391.json' : 'thesportsdb-nextleague-4328.json'),
    'www.thesportsdb.com/api/v1/json/123/eventsround.php': 'thesportsdb-nextleague-4328.json',
    'www.thesportsdb.com/api/v1/json/123/eventslast.php': 'thesportsdb-eventslast-133604.json',
    'www.thesportsdb.com/api/v1/json/123/eventsnext.php': 'thesportsdb-eventsnext-133604.json',
    'www.thesportsdb.com/api/v1/json/123/searchteams.php': 'thesportsdb-searchteams-arsenal.json',
    'www.thesportsdb.com/api/v1/json/123/all_leagues.php': 'thesportsdb-leagues.json',
};

(async () => {
    await check('sports_scores gives the league table', async () => {
        const f = fixtureFetch(routes);
        const out = await sports.run({ league: 'premier league' }, ctxOf(f.fetchImpl));
        assert.ok(!out.error, out.error);
        assert.strictEqual(out.data.league.name, 'English Premier League');
        assert.ok(out.data.standings.length >= 5, 'the table has rows');
        assert.strictEqual(out.data.standings[0].rank, 1);
        assert.strictEqual(out.data.standings[0].team, 'Manchester City');
        assert.ok(out.data.standings[0].played > 0);
        assert.ok(out.text.includes('Manchester City'), out.text);
        assert.ok(out.sources.some((s) => s.url.includes('thesportsdb')), 'the source is TheSportsDB');
    });

    await check('sports_scores gives the next games of the league', async () => {
        const f = fixtureFetch(routes);
        const out = await sports.run({ league: 'epl' }, ctxOf(f.fetchImpl));
        assert.ok(!out.error, out.error);
        assert.ok(out.data.next_games.length > 0, 'there are games');
        assert.ok(out.data.next_games[0].home && out.data.next_games[0].away, 'a game has both teams');
        assert.ok(out.text.includes('Next games'), out.text);
    });

    await check('sports_scores gives a team its last results, its next game and its place', async () => {
        const f = fixtureFetch(routes);
        const out = await sports.run({ league: 'premier league', team: 'Arsenal' }, ctxOf(f.fetchImpl));
        assert.ok(!out.error, out.error);
        assert.strictEqual(out.data.team.name, 'Arsenal');
        assert.ok(out.data.recent_games.length > 0, 'the last results');
        assert.ok(out.data.next_games.length > 0, 'the next games');
        assert.ok(out.data.team_standing, 'the team is in the table');
        assert.ok(out.text.includes('Arsenal'), out.text);
        assert.ok(f.calls.some((c) => c.url.includes('eventslast.php')), 'the last results are fetched');
        assert.ok(f.calls.some((c) => c.url.includes('eventsnext.php')), 'the next games are fetched');
    });

    await check('a league nobody knows is an error the model can act on', async () => {
        const f = fixtureFetch(routes);
        const out = await sports.run({ league: 'Quidditch League' }, ctxOf(f.fetchImpl));
        assert.ok(out.error, 'there is an error');
        assert.ok(out.error.includes('Quidditch League'), out.error);
    });

    await check('no league at all is an error, not a crash', async () => {
        const f = fixtureFetch(routes);
        const out = await sports.run({}, ctxOf(f.fetchImpl));
        assert.ok(out.error && out.error.includes('league'), out.error);
    });

    done();
})();
