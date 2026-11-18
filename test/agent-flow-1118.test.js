'use strict';
/**
 * What the owner's 11-18 runs showed (the menu's Vibe: "Test" answered in 2.8 s but showed nothing and spun "Working";
 * "Show off what you can do" asked a down weather service for five cities, sent Solana to the currency service, and
 * then withheld its paid answer because the checker gave no verdict):
 *   - a turn whose only text step is a status line still shows its answer in the conversation;
 *   - one model's "Asking a model" line is a plan step, never a text step that stands in for the answer;
 *   - a tool that fails twice the same way is down for the rest of the task;
 *   - "solana" is a coin, never the currency pair SOL/ANA;
 *   - when Open-Meteo's forecast does not answer, MET Norway's does.
 *   node test/agent-flow-1118.test.js
 */
const assert = require('assert');
const { noteFailure } = require('../server/runtime/loop');
const { createEngines } = require('../server/engines');
const weather = require('../server/runtime/tools/weather_now');
const market = require('../server/runtime/tools/market_quote');
const { boot, check, done } = require('./helpers/boot');

const json = (body) => ({ ok: true, status: 200, headers: new Map([['content-type', 'application/json']]), json: async () => body, text: async () => JSON.stringify(body) });

(async () => {
    await check('a tool that fails twice the same way is down for the task; different errors are not', () => {
        const state = {};
        noteFailure(state, 'weather_now', 'Open-Meteo forecast could not be reached: fetch failed');
        assert.ok(!state.downTools, 'once is not twice');
        noteFailure(state, 'market_quote', 'CoinGecko has no coin called "x"');
        noteFailure(state, 'weather_now', 'Open-Meteo forecast could not be reached: fetch failed');
        assert.ok(state.downTools && state.downTools.weather_now, 'the same error twice, for another city: down');
        assert.ok(!state.downTools.market_quote);
        noteFailure(state, 'market_quote', 'CoinGecko answered 429 after 3 tries');
        assert.ok(!state.downTools.market_quote, 'two different errors are not the same failure');
        assert.deepStrictEqual(JSON.parse(JSON.stringify(state)).downTools.weather_now.length > 0, true, 'a checkpoint keeps it');
    });

    await check('one model says "Asking a model" as a plan step, never as a text step', async () => {
        const said = [];
        const engines = createEngines({ models: { chat: async () => ({ text: 'Here is the answer.', cost_usd: 0.0001, model: 'deepseek-flash' }) } });
        const out = await engines.model({ task: 'Test', signal: new AbortController().signal, meter: async () => {}, budgetLeft: () => 1, emit: async (e) => said.push(e) });
        assert.strictEqual(out.text, 'Here is the answer.');
        assert.ok(said.length && said.every((e) => e.step !== 'text'), JSON.stringify(said));
    });

    await check('"solana" is priced as a coin by CoinGecko, never as the pair SOL/ANA', async () => {
        const urls = [];
        const fetch = async (url) => { urls.push(String(url)); return json({ solana: { usd: 74.47, usd_24h_change: 3.8, usd_market_cap: 44e9, last_updated_at: 1763431200 } }); };
        const r = await market.run({ asset: 'solana' }, { fetch });
        assert.ok(urls[0].startsWith('https://api.coingecko.com/'), urls[0]);
        assert.match(String(r.text), /One solana is 74\.47 USD/);
        const fx = [];
        await market.run({ asset: 'EURUSD' }, { fetch: async (url) => { fx.push(String(url)); return json({ rates: { USD: 1.09 }, date: '2026-11-18' }); } });
        assert.ok(fx[0].startsWith('https://api.frankfurter.dev/'), 'a real pair still goes to Frankfurter');
    });

    await check('when Open-Meteo\'s forecast does not answer, MET Norway\'s does', async () => {
        const fetch = async (url) => {
            const u = String(url);
            if (u.startsWith('https://geocoding-api.open-meteo.com/')) return json({ results: [{ name: 'Reykjavik', admin1: 'Capital Region', country: 'Iceland', country_code: 'IS', latitude: 64.1355, longitude: -21.8954, timezone: 'Atlantic/Reykjavik' }] });
            if (u.startsWith('https://api.open-meteo.com/')) throw new TypeError('fetch failed');
            if (u.startsWith('https://api.met.no/')) {
                return json({ properties: { timeseries: [
                    { time: '2026-11-18T02:00:00Z', data: { instant: { details: { air_temperature: -3.1, relative_humidity: 71, wind_speed: 1.9 } }, next_1_hours: { summary: { symbol_code: 'cloudy' }, details: { precipitation_amount: 0 } } } },
                    { time: '2026-11-18T14:00:00Z', data: { instant: { details: { air_temperature: 0.4 } }, next_1_hours: { summary: { symbol_code: 'lightrain' }, details: { precipitation_amount: 0.3 } } } },
                    { time: '2026-11-19T02:00:00Z', data: { instant: { details: { air_temperature: -3.5 } }, next_1_hours: { summary: { symbol_code: 'fair_night' }, details: { precipitation_amount: 0 } } } },
                ] } });
            }
            throw new Error(`unexpected ${u}`);
        };
        const r = await weather.run({ place: 'Reykjavik, Iceland (fallback test)', days: 2 }, { fetch });
        assert.ok(!r.isError, String(r.text));
        assert.match(String(r.text), /Reykjavik, Capital Region, Iceland — now -3\.1 °C/);
        assert.match(String(r.text), /MET Norway/);
        assert.ok(!/\d\.\d{3,}/.test(String(r.text)), 'numbers people read have one decimal');
    });

    await check('a finished turn shows its answer even when its only text step was a status line', async () => {
        const t = await boot();
        try {
            const ada = t.network.addUser('ada-flow');
            const db = t.ctx.s.db;
            const id = 'tsk_01M7P5YQ7QD0GWD96YE34DBSYH';
            const at = new Date().toISOString();
            await db.exec(`INSERT INTO tasks SELECT * FROM jsonb_populate_record(NULL::tasks, $1::jsonb)`, [JSON.stringify({
                id, requester: `user:${ada.subject}`, project_id: 'prj_01M7A6T4Y2ZNWTMM8VR6HW5T17', task: 'Test', mode: 'balanced', state: 'succeeded',
                budget_task: 0.05, budget_day: 0.5, last_seq: 5, webhooks: [], level: 'ask', created_at: at, finished_at: at,
                result: { answer: 'Working — I am here and ready.', agent: 'one-model', class: 'answer', model: 'deepseek-flash' },
            })]);
            const ev = [
                { kind: 'state', state: 'running' },
                { kind: 'output', step: 'plan', text: 'One model takes it, as you chose.', agent: 'one-model' },
                { kind: 'output', step: 'text', text: 'Asking a model, one call, no tools.', agent: 'one-model' },
                { kind: 'end', state: 'succeeded' },
            ];
            for (let i = 0; i < ev.length; i++) await db.exec('INSERT INTO task_events (task_id, seq, body) VALUES ($1, $2, $3::jsonb)', [id, i + 1, JSON.stringify({ ...ev[i], seq: i + 1, task_id: id, at })]);
            const r = await t.get(`/api/v1/runs/${id}/steps?conversation=1`, { as: ada });
            assert.strictEqual(r.status, 200, r.text);
            const steps = r.json().steps || [];
            assert.ok(steps.some((x) => x.kind === 'message' && x.from === 'agent' && /here and ready/.test(x.text || '')), JSON.stringify(steps.map((x) => [x.kind, x.from, String(x.text || '').slice(0, 40)])));
        } finally { await t.close(); }
    });
    await check('an approval is a card in the conversation, answered there; another conversation\'s is not', async () => {
        const t = await boot();
        try {
            const ada = t.network.addUser('ada-approve');
            const db = t.ctx.s.db;
            const id = 'tsk_01M7P78K4FGZ6J3PNXDMT9N9JA';
            const at = new Date().toISOString();
            await db.exec(`INSERT INTO tasks SELECT * FROM jsonb_populate_record(NULL::tasks, $1::jsonb)`, [JSON.stringify({
                id, requester: `user:${ada.subject}`, project_id: 'prj_01M7A6T4Y2ZNWTMM8VR6HW5T17', task: 'Test code something', mode: 'balanced', state: 'succeeded',
                budget_task: 0.05, budget_day: 0.5, last_seq: 2, webhooks: [], level: 'ask', created_at: at, finished_at: at,
                result: { answer: 'Your agent wants to start a coding task on your machine.', agent: 'openvibe-runtime', class: 'code' },
            })]);
            await db.exec('INSERT INTO task_events (task_id, seq, body) VALUES ($1, 1, $2::jsonb)', [id, JSON.stringify({ kind: 'state', state: 'running', seq: 1, task_id: id, at })]);
            const approvals = require('../server/agents/approvals');
            const ask = await approvals.request(t.ctx.s, { owner: `user:${ada.subject}`, taskId: id, kind: 'codes.task', summary: 'Write wordstats.py and its unittest, then run it', payload: { task: 'Write wordstats.py and its unittest, then run it' } });
            const steps = (await t.get(`/api/v1/runs/${id}/steps?conversation=1`, { as: ada })).json().steps;
            const card = steps.find((x) => x.kind === 'approval');
            assert.ok(card, JSON.stringify(steps.map((x) => x.kind)));
            assert.strictEqual(card.result.approval, ask.id);
            assert.deepStrictEqual(card.result.options.map((o) => o.id), ['approve', 'decline']);
            assert.strictEqual(card.title, 'Start this coding task on your machine?');
            assert.ok(steps.indexOf(card) > steps.findIndex((x) => x.kind === 'message' && x.from === 'agent'), 'the card follows the answer');

            const bo = t.network.addUser('bo-approve');
            const theirs = await t.get(`/api/v1/runs/${id}/approvals/${ask.id}`, { headers: { authorization: `Bearer ${t.network.userToken(bo)}` }, method: 'POST', json: { answer: 'approve' } });
            assert.ok([403, 404].includes(theirs.status), `another person never answers it (${theirs.status})`);
            const bad = await t.get(`/api/v1/runs/${id}/approvals/${ask.id}`, { headers: { authorization: `Bearer ${t.network.userToken(ada)}` }, method: 'POST', json: { answer: 'maybe' } });
            assert.strictEqual(bad.status, 422);
            const no = await t.get(`/api/v1/runs/${id}/approvals/${ask.id}`, { headers: { authorization: `Bearer ${t.network.userToken(ada)}` }, method: 'POST', json: { answer: 'decline' } });
            assert.strictEqual(no.status, 200, no.text);
            assert.strictEqual(no.json().approval.state, 'declined');
            const after = (await t.get(`/api/v1/runs/${id}/steps?conversation=1`, { as: ada })).json().steps.find((x) => x.kind === 'approval');
            assert.deepStrictEqual([after.result.answer, after.result.answer_label], ['decline', 'Declined']);
        } finally { await t.close(); }
    });
    done();
})();
