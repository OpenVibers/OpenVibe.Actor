'use strict';
/**
 * market_quote: a price for a crypto asset or a currency pair.
 *
 * Crypto comes from CoinGecko's simple price API (https://www.coingecko.com/en/api), which is free
 * and keyless; the rate-limited free tier is why a quote is cached for a minute.
 * Foreign exchange comes from Frankfurter (https://www.frankfurter.app), the European Central
 * Bank's reference rates, refreshed once a working day.
 *
 * Stocks are deliberately left out: the free quote feeds that need no key (stooq's CSV, Yahoo's
 * chart endpoint) answer a browser check instead of data from a server, so a share price could not
 * be trusted to be current. This tool never invents one; it says it has no stock source.
 */
const { Cache, memo, requestJson, ToolError, round, group, source, fail } = require('./lib/util');

const TTL_MS = 60 * 1000;
const CACHE = new Cache();

const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price';
const FRANKFURTER = 'https://api.frankfurter.dev/v1/latest';

/** The coins a person is most likely to ask for, by ticker. */
const COIN_IDS = {
    BTC: 'bitcoin', ETH: 'ethereum', USDT: 'tether', USDC: 'usd-coin', BNB: 'binancecoin',
    SOL: 'solana', XRP: 'ripple', DOGE: 'dogecoin', ADA: 'cardano', DOT: 'polkadot',
    LINK: 'chainlink', TRX: 'tron', AVAX: 'avalanche-2', SHIB: 'shiba-inu', MATIC: 'matic-network',
    TON: 'the-open-network', LTC: 'litecoin', BCH: 'bitcoin-cash', ATOM: 'cosmos', UNI: 'uniswap',
};

/** The currencies Frankfurter knows (the ECB's set). */
const isCurrencyCode = (code) => typeof code === 'string' && /^[A-Za-z]{3}$/.test(code);

/** "btc", "BTC", "bitcoin" or "avalanche-2" all name a coin; a pair like "EURUSD" names a rate. */
function parseAsset(raw) {
    const asset = String(raw || '').trim();
    if (!asset) return null;
    const pair = asset.replace(/[^A-Za-z]/g, '');
    if (pair.length === 6 && isCurrencyCode(pair.slice(0, 3)) && isCurrencyCode(pair.slice(3))) {
        return { kind: 'fx', base: pair.slice(0, 3).toUpperCase(), quote: pair.slice(3).toUpperCase() };
    }
    const upper = asset.toUpperCase();
    if (COIN_IDS[upper]) return { kind: 'crypto', id: COIN_IDS[upper], symbol: upper, name: null };
    const lower = asset.toLowerCase();
    if (/^[a-z0-9][a-z0-9-]*$/.test(lower)) return { kind: 'crypto', id: lower, symbol: null, name: null };
    return null;
}

async function cryptoQuote(ctx, id, currency, signal) {
    const url = COINGECKO
        + '?ids=' + encodeURIComponent(id)
        + '&vs_currencies=' + encodeURIComponent(currency)
        + '&include_24hr_change=true&include_market_cap=true&include_last_updated_at=true';
    const { data } = await requestJson(ctx, url, { signal, label: 'CoinGecko' });
    const entry = data && data[id];
    if (!entry) throw new ToolError('CoinGecko has no coin called "' + id + '"', 'tool.not_found');
    const price = entry[currency];
    if (price == null) throw new ToolError('CoinGecko has no ' + currency.toUpperCase() + ' price for "' + id + '"', 'tool.not_found');
    return { price, change: entry[currency + '_24h_change'], marketCap: entry[currency + '_market_cap'], updatedAt: entry.last_updated_at };
}

async function fxQuote(ctx, base, quote, signal) {
    const url = FRANKFURTER + '?base=' + encodeURIComponent(base) + '&symbols=' + encodeURIComponent(quote);
    const { data } = await requestJson(ctx, url, { signal, label: 'Frankfurter' });
    const rate = data && data.rates && data.rates[quote];
    if (rate == null) throw new ToolError('Frankfurter does not know the currency "' + quote + '"', 'tool.not_found');
    return { price: rate, change: null, marketCap: null, updatedAt: null, date: data.date };
}

module.exports = {
    name: 'market_quote',
    description: 'A current price for a crypto asset (bitcoin, ethereum, SOL, ...) or a currency pair (EURUSD). '
        + 'Crypto comes from CoinGecko and foreign exchange from Frankfurter (the ECB reference rates); both are free '
        + 'and need no key. Every quote carries the time it was taken. '
        + 'Stocks are not part of this tool: there is no share-price source that is both keyless and reliable from a '
        + 'server, so this tool never quotes a stock.',
    input: {
        type: 'object',
        properties: {
            asset: { type: 'string', description: 'The asset to price: a coin ("bitcoin", "ETH", "solana") or a currency pair ("EURUSD", "USD/JPY").' },
            currency: { type: 'string', description: 'The currency to price a coin in. Defaults to usd.' },
        },
        required: ['asset'],
    },
    scope: 'public',
    costUsd: 0,
    timeoutMs: 15000,
    sources: [
        source('https://www.coingecko.com/en/api', 'CoinGecko: free crypto price API'),
        source('https://www.frankfurter.app/', 'Frankfurter: ECB reference exchange rates'),
    ],

    async run(input = {}, ctx = {}) {
        const parsed = parseAsset(input.asset);
        if (!parsed) {
            return fail('market_quote needs an asset, for example "bitcoin", "ETH" or "EURUSD".');
        }
        const currency = String(input.currency || 'usd').trim().toLowerCase();
        const key = 'quote:' + (parsed.kind === 'fx' ? parsed.base + parsed.quote : parsed.id) + ':' + currency;

        try {
            const result = await memo(CACHE, key, TTL_MS, async () => {
                if (parsed.kind === 'fx') {
                    const q = await fxQuote(ctx, parsed.base, parsed.quote, ctx.signal);
                    return buildFx(parsed, q);
                }
                const q = await cryptoQuote(ctx, parsed.id, currency, ctx.signal);
                return buildCrypto(parsed, q, currency);
            });
            return result;
        } catch (err) {
            return fail((err && err.message) || 'the quote could not be fetched');
        }
    },
};

function buildCrypto(parsed, q, currency) {
    const code = currency.toUpperCase();
    const quoteTime = q.updatedAt ? new Date(q.updatedAt * 1000).toISOString() : new Date().toISOString();
    const change = q.change == null ? null : round(q.change, 4);
    const lines = [
        'One ' + parsed.id + ' is ' + group(q.price) + ' ' + code + '.',
    ];
    if (change != null) lines.push('Over 24 hours: ' + (change >= 0 ? 'up ' : 'down ') + Math.abs(change) + '%.');
    if (q.marketCap != null) lines.push('Market capitalisation: ' + group(q.marketCap) + ' ' + code + '.');
    lines.push('Quoted by CoinGecko at ' + quoteTime + '.');
    return {
        text: lines.join(' '),
        data: {
            asset: parsed.id,
            kind: 'crypto',
            currency: code,
            price: round(q.price, 8),
            change_24h_percent: change,
            market_cap: q.marketCap == null ? null : round(q.marketCap, 2),
            quote_time: quoteTime,
            retrieved_at: new Date().toISOString(),
            source: 'CoinGecko',
        },
        sources: [
            source('https://www.coingecko.com/en/coins/' + parsed.id, 'CoinGecko: ' + parsed.id),
            source('https://www.coingecko.com/en/api', 'CoinGecko: free crypto price API'),
        ],
        artifacts: [],
    };
}

function buildFx(parsed, q) {
    const quoteTime = q.date || new Date().toISOString().slice(0, 10);
    const lines = [
        '1 ' + parsed.base + ' = ' + group(q.price) + ' ' + parsed.quote + '.',
        'The rate is the European Central Bank reference rate of ' + quoteTime + ', published once a working day.',
    ];
    return {
        text: lines.join(' '),
        data: {
            asset: parsed.base + '/' + parsed.quote,
            kind: 'fx',
            base: parsed.base,
            quote: parsed.quote,
            currency: parsed.quote,
            price: round(q.price, 8),
            change_24h_percent: null,
            quote_time: quoteTime,
            retrieved_at: new Date().toISOString(),
            source: 'Frankfurter (ECB reference rates)',
        },
        sources: [source('https://www.frankfurter.app/', 'Frankfurter: ECB reference exchange rates')],
        artifacts: [],
    };
}
