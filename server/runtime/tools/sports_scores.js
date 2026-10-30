'use strict';
/**
 * sports_scores: the standings of a league and the games around them.
 *
 * Source: TheSportsDB's free API (https://www.thesportsdb.com/api.php). Their public test key
 * "123" answers the endpoints used here (a league table, the next games of a league, the last and
 * next games of a team). Their terms: the free tier is rate-limited, so every answer here is
 * cached for ten minutes and a league costs one table plus one page of games; the data is theirs,
 * and they ask for a credit to TheSportsDB, which this tool gives in its sources. A deployment
 * that wants more should set its own key (ctx.config.thesportsdbKey, or THESPORTSDB_KEY).
 *
 * The fixtures in test/fixtures/tools/ are recorded answers, so the test suite never calls out.
 */
const { Cache, ToolError, memo, requestJson, round, source, fail } = require('./lib/util');

const BASE = 'https://www.thesportsdb.com/api/v1/json';
const TTL_MS = 10 * 60 * 1000;
const CACHE = new Cache();

/** The leagues this tool knows by name, with TheSportsDB's league id. */
const LEAGUES = {
    'premier league': { id: '4328', name: 'English Premier League', sport: 'Soccer' },
    'english premier league': { id: '4328', name: 'English Premier League', sport: 'Soccer' },
    'epl': { id: '4328', name: 'English Premier League', sport: 'Soccer' },
    'championship': { id: '4329', name: 'English League Championship', sport: 'Soccer' },
    'league championship': { id: '4329', name: 'English League Championship', sport: 'Soccer' },
    'scottish premier league': { id: '4330', name: 'Scottish Premier League', sport: 'Soccer' },
    'bundesliga': { id: '4331', name: 'German Bundesliga', sport: 'Soccer' },
    'serie a': { id: '4332', name: 'Italian Serie A', sport: 'Soccer' },
    'italian serie a': { id: '4332', name: 'Italian Serie A', sport: 'Soccer' },
    'ligue 1': { id: '4334', name: 'French Ligue 1', sport: 'Soccer' },
    'la liga': { id: '4335', name: 'Spanish La Liga', sport: 'Soccer' },
    'spanish la liga': { id: '4335', name: 'Spanish La Liga', sport: 'Soccer' },
    'greek super league': { id: '4336', name: 'Greek Super League 1', sport: 'Soccer' },
    'eredivisie': { id: '4337', name: 'Dutch Eredivisie', sport: 'Soccer' },
    'belgian pro league': { id: '4338', name: 'Belgian Pro League', sport: 'Soccer' },
    'mls': { id: '4346', name: 'Major League Soccer', sport: 'Soccer' },
    'major league soccer': { id: '4346', name: 'Major League Soccer', sport: 'Soccer' },
    'brasileirao': { id: '4404', name: 'Brazilian Série A', sport: 'Soccer' },
    'brazilian serie a': { id: '4404', name: 'Brazilian Série A', sport: 'Soccer' },
    'nba': { id: '4387', name: 'National Basketball Association', sport: 'Basketball' },
    'nfl': { id: '4391', name: 'National Football League', sport: 'American Football' },
    'national football league': { id: '4391', name: 'National Football League', sport: 'American Football' },
    'nhl': { id: '4380', name: 'National Hockey League', sport: 'Ice Hockey' },
    'national hockey league': { id: '4380', name: 'National Hockey League', sport: 'Ice Hockey' },
    'mlb': { id: '4424', name: 'Major League Baseball', sport: 'Baseball' },
    'major league baseball': { id: '4424', name: 'Major League Baseball', sport: 'Baseball' },
};

const KEY = (ctx) => {
    const fromConfig = ctx && ctx.config && ctx.config.thesportsdbKey;
    return String(fromConfig || process.env.THESPORTSDB_KEY || '123');
};

async function call(ctx, path, { signal, label } = {}) {
    const url = BASE + '/' + KEY(ctx) + '/' + path;
    const { data } = await requestJson(ctx, url, { signal, label: label || 'TheSportsDB' });
    return data || {};
}

/** The leagues TheSportsDB lists, for a name this tool does not know. */
async function allLeagues(ctx, signal) {
    return await memo(CACHE, 'sports:leagues', 6 * 60 * 60 * 1000, async () => {
        const data = await call(ctx, 'all_leagues.php', { signal });
        return Array.isArray(data.leagues) ? data.leagues : [];
    });
}

/** The league behind a name. */
async function resolveLeague(ctx, league, signal) {
    const key = String(league || '').trim().toLowerCase();
    if (!key) throw new ToolError('sports_scores needs a league, for example "premier league" or "nba".', 'tool.not_found');
    if (LEAGUES[key]) return LEAGUES[key];
    const list = await allLeagues(ctx, signal);
    const exact = list.find((l) => String(l.strLeague).toLowerCase() === key);
    if (exact) return { id: String(exact.idLeague), name: exact.strLeague, sport: exact.strSport };
    const partial = list.find((l) => String(l.strLeague).toLowerCase().includes(key));
    if (partial) return { id: String(partial.idLeague), name: partial.strLeague, sport: partial.strSport };
    throw new ToolError('this tool does not know the league "' + league + '". It knows ' + Object.values(LEAGUES).slice(0, 8).map((l) => l.name).join(', ') + ' and more.', 'tool.not_found');
}

/** The league table. */
async function standings(ctx, league, signal) {
    const data = await call(ctx, 'lookuptable.php?l=' + encodeURIComponent(league.id), { signal });
    const table = Array.isArray(data.table) ? data.table : [];
    return table.map((row) => ({
        rank: row.intRank ? Number(row.intRank) : null,
        team: row.strTeam || null,
        team_id: row.idTeam ? String(row.idTeam) : null,
        played: row.intPlayed != null ? Number(row.intPlayed) : null,
        won: row.intWin != null ? Number(row.intWin) : null,
        drawn: row.intDraw != null ? Number(row.intDraw) : null,
        lost: row.intLoss != null ? Number(row.intLoss) : null,
        goals_for: row.intGoalsFor != null ? Number(row.intGoalsFor) : null,
        goals_against: row.intGoalsAgainst != null ? Number(row.intGoalsAgainst) : null,
        goal_difference: row.intGoalDiff != null ? Number(row.intGoalDiff) : null,
        points: row.intPoints != null ? Number(row.intPoints) : null,
        form: row.strForm || null,
        note: row.strDescription || null,
        season: row.strSeason || null,
        group: row.strGroup || null,
    }));
}

/** The games, as one list whatever the endpoint called them. */
const gamesOf = (data) => {
    const list = Array.isArray(data.events) ? data.events : (Array.isArray(data.results) ? data.results : []);
    return list.map((g) => ({
        timestamp: g.strTimestamp || null,
        date: g.strTimestamp ? String(g.strTimestamp).slice(0, 10) : null,
        time: g.strTimestamp ? String(g.strTimestamp).slice(11, 16) : null,
        event: g.strEvent || null,
        home: g.strHomeTeam || null,
        away: g.strAwayTeam || null,
        home_score: g.intHomeScore != null ? Number(g.intHomeScore) : null,
        away_score: g.intAwayScore != null ? Number(g.intAwayScore) : null,
        status: g.strStatus || null,
        venue: g.strVenue || null,
        league: g.strLeague || null,
    }));
};

async function nextLeagueGames(ctx, league, signal) {
    const data = await call(ctx, 'eventsnextleague.php?id=' + encodeURIComponent(league.id), { signal });
    return gamesOf(data);
}

/** The round just finished, so the games of it are the league's last results. */
async function lastRoundGames(ctx, league, table, signal) {
    const played = table.map((row) => row.played).filter((n) => typeof n === 'number');
    const season = (table.find((row) => row.season) || {}).season;
    if (!played.length || !season) return [];
    const round = Math.max(...played);
    const data = await call(ctx, 'eventsround.php?id=' + encodeURIComponent(league.id) + '&r=' + round + '&s=' + encodeURIComponent(season), { signal });
    const games = gamesOf(data);
    return games.filter((g) => g.home_score != null || g.away_score != null);
}

/** A team, by name. */
async function findTeam(ctx, team, signal) {
    const data = await call(ctx, 'searchteams.php?t=' + encodeURIComponent(team), { signal });
    const teams = Array.isArray(data.teams) ? data.teams : [];
    const wanted = String(team).trim().toLowerCase();
    const hit = teams.find((t) => String(t.strTeam).toLowerCase() === wanted)
        || teams.find((t) => String(t.strTeam).toLowerCase().includes(wanted))
        || teams[0];
    if (!hit) throw new ToolError('no team called "' + team + '" was found', 'tool.not_found');
    return {
        id: String(hit.idTeam),
        name: hit.strTeam || null,
        sport: hit.strSport || null,
        league: hit.strLeague || null,
        league_id: hit.idLeague ? String(hit.idLeague) : null,
        badge: hit.strBadge || null,
    };
}

async function teamGames(ctx, teamId, which, signal) {
    const data = await call(ctx, which + '.php?id=' + encodeURIComponent(teamId), { signal });
    return gamesOf(data);
}

module.exports = {
    name: 'sports_scores',
    description: 'The standings of a league and the games around them: the league table, the results of the last round '
        + 'and the next games, or the same for one team (its last results, its next game and its place in the table). '
        + 'Uses TheSportsDB (free, no key). Say the league ("premier league", "la liga", "nba", "nfl", "mls") and, '
        + 'optionally, a team.',
    input: {
        type: 'object',
        properties: {
            league: { type: 'string', description: 'The league, for example "premier league", "la liga", "bundesliga", "nba", "nfl", "mls".' },
            team: { type: 'string', description: 'A team in that league, for example "Arsenal" or "Lakers".' },
        },
        required: ['league'],
    },
    scope: 'public',
    costUsd: 0,
    timeoutMs: 15000,
    sources: [source('https://www.thesportsdb.com/', 'TheSportsDB: free sports data')],

    async run(input = {}, ctx = {}) {
        const leagueName = String(input.league || '').trim();
        const teamName = String(input.team || '').trim();
        if (!leagueName && !teamName) {
            return fail('sports_scores needs a league, for example "premier league" or "nba".');
        }
        const key = 'sports:' + leagueName.toLowerCase() + ':' + teamName.toLowerCase();

        try {
            const result = await memo(CACHE, key, TTL_MS, async () => {
                const league = await resolveLeague(ctx, leagueName || 'premier league', ctx.signal);
                // Some leagues have no table in the free key (the NFL among them); the games still do.
                let table = [];
                try {
                    table = await standings(ctx, league, ctx.signal);
                } catch {
                    table = [];
                }
                const team = teamName ? await findTeam(ctx, teamName, ctx.signal) : null;

                let recent = [];
                let next = [];
                if (team) {
                    recent = await teamGames(ctx, team.id, 'eventslast', ctx.signal);
                    next = await teamGames(ctx, team.id, 'eventsnext', ctx.signal);
                } else {
                    next = await nextLeagueGames(ctx, league, ctx.signal);
                    recent = await lastRoundGames(ctx, league, table, ctx.signal);
                }
                const row = team ? table.find((r) => r.team_id === team.id) || null : null;
                return build(league, table, row, team, recent, next);
            });
            return result;
        } catch (err) {
            return fail((err && err.message) || 'the standings could not be fetched');
        }
    },
};

function build(league, table, teamRow, team, recent, next) {
    const lines = [];
    const heading = team ? team.name + ' (' + league.name + ')' : league.name;
    lines.push(heading + ' — standings');

    const rows = team && teamRow ? [teamRow] : table.slice(0, 10);
    for (const row of rows) {
        const bits = [];
        if (row.played != null) bits.push(row.played + ' played');
        if (row.won != null) bits.push(row.won + ' won');
        if (row.drawn != null) bits.push(row.drawn + ' drawn');
        if (row.lost != null) bits.push(row.lost + ' lost');
        if (row.points != null) bits.push(row.points + ' points');
        if (row.goals_for != null) bits.push(row.goals_for + ' goals for');
        if (row.goals_against != null) bits.push(row.goals_against + ' against');
        lines.push((row.rank != null ? row.rank + '. ' : '') + row.team + (bits.length ? ' — ' + bits.join(', ') : '') + (row.form ? ' (form ' + row.form + ')' : '') + (row.note ? ' [' + row.note + ']' : ''));
    }
    if (team && !teamRow) lines.push(team.name + ' is not in this league table.');

    if (recent.length) {
        lines.push('Last results:');
        for (const g of recent.slice(0, 5)) {
            lines.push('- ' + (g.date || '') + ' ' + (g.home || '?') + ' ' + (g.home_score != null ? g.home_score : '-') + ' - ' + (g.away_score != null ? g.away_score : '-') + ' ' + (g.away || '?'));
        }
    }
    if (next.length) {
        lines.push('Next games:');
        for (const g of next.slice(0, 5)) {
            lines.push('- ' + (g.date || '') + (g.time ? ' ' + g.time : '') + ' ' + (g.home || '?') + ' vs ' + (g.away || '?'));
        }
    }
    if (!recent.length && !next.length) lines.push('No games are listed for this league right now.');

    return {
        text: lines.join('\n'),
        data: {
            league: { id: league.id, name: league.name, sport: league.sport },
            team: team ? { id: team.id, name: team.name, league: team.league } : null,
            standings: table,
            team_standing: teamRow,
            recent_games: recent,
            next_games: next,
            fetched_at: new Date().toISOString(),
        },
        sources: [source('https://www.thesportsdb.com/', 'TheSportsDB: free sports data')],
        artifacts: [],
    };
}
