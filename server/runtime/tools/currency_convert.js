'use strict';
/**
 * currency_convert: how much one currency is worth in another.
 *
 * Source: Frankfurter (https://www.frankfurter.app), which republishes the European Central
 * Bank's reference rates. It is free, keyless and covers about thirty currencies; the rates are
 * published once a working day (around 16:00 CET), so the answer carries the date of the rate and
 * not just the moment of the call.
 */
const { Cache, memo, requestJson, ToolError, round, group, source, fail } = require('./lib/util');

const BASE = 'https://api.frankfurter.dev/v1';
const TTL_MS = 60 * 60 * 1000;
const CACHE = new Cache();

const isCode = (code) => typeof code === 'string' && /^[A-Za-z]{3}$/.test(code);

async function currencies(ctx, signal) {
    return await memo(CACHE, 'fx:currencies', TTL_MS, async () => {
        const { data } = await requestJson(ctx, BASE + '/currencies', { signal, label: 'Frankfurter' });
        return (data && typeof data === 'object') ? data : {};
    });
}

async function rates(ctx, base, symbols, signal) {
    const url = BASE + '/latest?base=' + encodeURIComponent(base)
        + (symbols && symbols.length ? '&symbols=' + encodeURIComponent(symbols.join(',')) : '');
    const { data } = await requestJson(ctx, url, { signal, label: 'Frankfurter' });
    if (!data || !data.rates) throw new ToolError('Frankfurter answered without rates', 'tool.bad_answer');
    return data;
}

module.exports = {
    name: 'currency_convert',
    description: 'Convert an amount of money between currencies at the European Central Bank reference rates '
        + '(Frankfurter). For example: convert 250 USD to EUR, or "1 JPY in GBP". The rates are published once a '
        + 'working day and the answer says which day they are from.',
    input: {
        type: 'object',
        properties: {
            amount: { type: 'number', description: 'The amount to convert. Defaults to 1.' },
            from: { type: 'string', description: 'The currency to convert from, as its three-letter code (USD, EUR, GBP).' },
            to: { type: 'string', description: 'The currency (or comma-separated currencies) to convert to. Leave it out to get every rate for the base currency.' },
        },
        required: ['from'],
    },
    scope: 'public',
    costUsd: 0,
    timeoutMs: 15000,
    sources: [source('https://www.frankfurter.app/', 'Frankfurter: ECB reference exchange rates')],

    async run(input = {}, ctx = {}) {
        const base = String(input.from || '').trim().toUpperCase();
        if (!base) return fail('currency_convert needs the currency to convert from, for example from: "USD".');
        const amount = Number.isFinite(Number(input.amount)) ? Number(input.amount) : 1;
        const wanted = String(input.to || '').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);

        try {
            const known = await currencies(ctx, ctx.signal);
            if (Object.keys(known).length && !known[base]) {
                return fail('Frankfurter does not know the currency "' + base + '". It covers the euro and the major world currencies.');
            }
            for (const code of wanted) {
                if (Object.keys(known).length && !known[code]) {
                    return fail('Frankfurter does not know the currency "' + code + '".');
                }
            }
            if (!wanted.length && known[base] && Object.keys(known).length > 1) {
                const all = Object.keys(known).filter((c) => c !== base);
                const data = await rates(ctx, base, all, ctx.signal);
                return buildAll(base, amount, data);
            }
            const data = await rates(ctx, base, wanted, ctx.signal);
            return build(base, amount, wanted, data);
        } catch (err) {
            return fail((err && err.message) || 'the exchange rate could not be fetched');
        }
    },
};

function build(base, amount, wanted, data) {
    const date = data.date || null;
    const lines = [];
    const converted = [];
    for (const code of wanted) {
        const rate = data.rates[code];
        if (rate == null) {
            lines.push('No rate for ' + code + '.');
            continue;
        }
        const value = amount * rate;
        converted.push({ currency: code, rate: round(rate, 8), value: round(value, 6), name: null });
        lines.push(
            amount + ' ' + base + ' = ' + group(value) + ' ' + code
            + ' (1 ' + base + ' = ' + round(rate, 6) + ' ' + code + ').'
        );
    }
    lines.push('The rate is the European Central Bank reference rate of ' + (date || 'the latest working day') + '.');
    return {
        text: lines.join(' '),
        data: {
            kind: 'conversion',
            amount,
            from: base,
            to: wanted,
            date,
            rates: converted,
            quote_time: date,
            retrieved_at: new Date().toISOString(),
            source: 'Frankfurter (ECB reference rates)',
        },
        sources: [source('https://www.frankfurter.app/', 'Frankfurter: ECB reference exchange rates')],
        artifacts: [],
    };
}

function buildAll(base, amount, data) {
    const entries = Object.entries(data.rates || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)
        .map(([code, rate]) => ({ currency: code, rate: round(rate, 8), value: round(amount * rate, 6) }));
    const lines = entries.slice(0, 10).map((e) => '1 ' + base + ' = ' + round(e.rate, 6) + ' ' + e.currency);
    lines.push('The rate is the European Central Bank reference rate of ' + (data.date || 'the latest working day') + '.');
    return {
        text: lines.join('\n'),
        data: {
            kind: 'conversion',
            amount,
            from: base,
            to: entries.map((e) => e.currency),
            date: data.date || null,
            rates: entries,
            quote_time: data.date || null,
            retrieved_at: new Date().toISOString(),
            source: 'Frankfurter (ECB reference rates)',
        },
        sources: [source('https://www.frankfurter.app/', 'Frankfurter: ECB reference exchange rates')],
        artifacts: [],
    };
}
