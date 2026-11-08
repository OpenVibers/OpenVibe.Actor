'use strict';
/**
 * HO7: an agent that can spend the person's Vibes.
 *
 * The tool is only offered to an agent whose person set a weekly allowance. A tip always asks (money is the floor:
 * no level and no "always allow" rule covers it), and the money moves only when the person approves the card with
 * their own session, once, with their own token, through OpenVibe.Tips' checkout. An ask over what is left of the
 * allowance (or under Tips' own minimum) is refused before the person ever sees it. A definite refusal from Tips
 * leaves the request pending with its reason; an unknown answer keeps the claim paying, so the week still counts it,
 * and a retry after the stale window sends the same Idempotency-Key, which Tips replays.
 */
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const { serviceAuth } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const personal = require('../server/agents/personal');
const contacts = require('../server/agents/contacts');
const approvals = require('../server/agents/approvals');
const allows = require('../server/agents/allows');
const levels = require('../server/agents/levels');
const spend = require('../server/agents/spend');
const tool = require('../server/runtime/tools/spend_vibes');

const SAME = { 'sec-fetch-site': 'same-origin' };
const UNCONFIRMED = 'We could not confirm the tip yet; nothing will be paid twice.';

/**
 * A stand-in for OpenVibe.Tips: the creator profile resolve() reads, and the one checkout a person's own token pays.
 * A replay with the same Idempotency-Key returns the first interaction (200, Idempotent-Replayed), as Tips does.
 * state.refuse is what Tips answers with; state.delayMs makes the first request outlive the client's timeout, so its
 * interaction is recorded while the caller sees an unknown outcome.
 */
async function startTips({ creators = {} } = {}) {
    const calls = [];       // POST /api/v1/checkout, with the headers and body Actor sent
    const views = [];       // GET /api/v1/profiles/:creator
    const payments = new Map();  // Idempotency-Key → the interaction Tips recorded first
    const state = { refuse: null, delayMs: 0 };
    const list = Object.entries(creators).map(([handle, c]) => ({ handle, min: 1, ...c }));
    const find = (ref) => list.find((c) => c.handle === ref || c.subject === ref) || null;
    let n = 0;
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const json = (status, obj, headers = {}) => {
                if (res.destroyed || res.writableEnded) return;
                try { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); } catch { /* the client gave up */ }
            };
            const m = /^\/api\/v1\/profiles\/([^/?]+)$/.exec(req.url);
            if (m && req.method === 'GET') {
                const ref = decodeURIComponent(m[1]);
                views.push(ref);
                const c = find(ref);
                if (!c) return json(404, { code: 'tips.creator_not_found', detail: 'no tip profile for this creator' });
                return json(200, {
                    profile: {
                        creator: { type: 'user', id: c.subject }, handle: c.handle, display_name: c.name || c.handle,
                        minimums: { tip: c.min || 1 },
                    },
                });
            }
            if (req.url === '/api/v1/checkout' && req.method === 'POST') {
                const body = raw ? JSON.parse(raw) : {};
                const key = req.headers['idempotency-key'] || null;
                calls.push({ auth: req.headers.authorization || null, key, body, contentType: req.headers['content-type'] || null });
                const answer = () => {
                    if (state.refuse) {
                        const status = state.refuse.status || 409;
                        return json(status, {
                            type: 'about:blank', title: state.refuse.detail, status,
                            code: state.refuse.code || 'tips.refused', detail: state.refuse.detail,
                        });
                    }
                    const prev = key ? payments.get(key) : null;
                    if (prev) return json(200, { interaction: prev }, { 'Idempotent-Replayed': 'true' });
                    const c = find(body.creator);
                    if (!c) return json(404, { code: 'tips.creator_not_found', detail: 'no tip profile for this creator' });
                    const interaction = { id: `tint_${String(++n).padStart(26, '0')}`, creator: { type: 'user', id: c.subject }, amount: body.amount, payment: { state: 'settled' } };
                    if (key) payments.set(key, interaction);
                    return json(201, { interaction });
                };
                if (state.delayMs) { setTimeout(answer, state.delayMs); return; }
                return answer();
            }
            return json(404, { code: 'not_found', detail: 'no such route' });
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, views, payments, state, close: () => new Promise((r) => server.close(r)) };
}

/** The model turn that asks for the tip, and the answer that follows it. */
const tipTurn = (args) => ({ content: 'Tipping the creator.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'spend_vibes', arguments: JSON.stringify(args) } }] });
const doneTurn = { content: 'The tip was sent.' };

(async () => {
    const tips = await startTips({
        creators: {
            bo: { subject: 'usr_01JZ7QK9F3M8N2P4R6T8V0X2YB', name: 'Bo' },
            nina: { subject: 'usr_01JZ7QK9F3M8N2P4R6T8V0X2YC', name: 'Nina', min: 10 },
        },
    });
    let now = Date.now();
    const t = await boot({
        env: { ACTOR_TIPS_URL: tips.url },
        now: () => now,
        adapters: { checkers: { openai: async () => ({ text: '{"ok":true,"reason":"fine"}', cost_usd: 0 }) } },
    });
    try {
        const ada = t.network.addUser('ada');
        const owner = `user:${ada.subject}`;
        const creator = 'usr_01JZ7QK9F3M8N2P4R6T8V0X2YB';
        const agent = (await personal.create(t.ctx.s, t.config, owner, {
            name: 'Tipper', instructions: 'Tip creators when the person asks for it.', mode: 'balanced',
            budget_per_run_usd: 0.05, daily_runs_max: 5, schedule: 'off', status: 'active',
        })).row;

        const moneyApprovals = async () => await t.ctx.s.db.many("SELECT * FROM actor_approvals WHERE owner = $1 AND kind = 'money' ORDER BY created_at DESC", [owner]);
        const payloadOf = (a) => (typeof a.payload === 'string' ? JSON.parse(a.payload || '{}') : (a.payload || {}));
        const asksFor = (approvalId) => tips.calls.filter((c) => c.key === approvalId);
        const askTip = async (args, { script = null } = {}) => {
            t.providers.state.script = script || [tipTurn(args), doneTurn];
            const out = await personal.run(t.ctx, agent, 'Send the tip the person asked for.');
            const row = await t.waitFor(out.task.id);
            return row;
        };

        await check('the person sets the weekly allowance on the agent\'s page, and 0 turns it off', async () => {
            const page = await t.get(`/me/agents/${agent.id}`, { as: ada });
            assert.ok(page.text.includes('What it may spend'), 'the agent page has the allowance panel');
            const set = await t.get(`/me/agents/${agent.id}/spend`, { as: ada, form: { weekly_vibes: '25' }, headers: SAME });
            assert.strictEqual(set.status, 303, set.text.slice(0, 200));
            assert.strictEqual((await spend.allowance(t.ctx.s, owner, agent.id)).weekly, 25, 'the person\'s setting was saved');
            // Only a whole, non-negative number of Vibes, at most the cap.
            const bad = await t.get(`/me/agents/${agent.id}/spend`, { as: ada, form: { weekly_vibes: '-1' }, headers: SAME });
            assert.strictEqual(bad.status, 422);
            assert.strictEqual((await spend.allowance(t.ctx.s, owner, agent.id)).weekly, 25, 'a bad setting changed nothing');
            const off = await t.get(`/me/agents/${agent.id}/spend`, { as: ada, form: { weekly_vibes: '0' }, headers: SAME });
            assert.strictEqual(off.status, 303);
            assert.strictEqual((await spend.allowance(t.ctx.s, owner, agent.id)).weekly, 0, '0 is off');
        });

        await check('an agent with no weekly allowance is never offered the spending tool', async () => {
            const defs = t.ctx.registry.definitions({ requester: owner, mode: 'balanced', config: t.config, spend: { weekly: 0, agent_id: agent.id } });
            assert.ok(!defs.some((d) => d.function.name === 'spend_vibes'), 'no allowance, no tool');
            const offered = t.ctx.registry.definitions({ requester: owner, mode: 'balanced', config: t.config, spend: { weekly: 20, agent_id: agent.id } });
            assert.ok(offered.some((d) => d.function.name === 'spend_vibes'), 'an allowance offers the tool');
            assert.strictEqual(tool.available({ config: t.config, spend: { weekly: 0 } }), false);
            assert.strictEqual(tool.available({ config: t.config, spend: { weekly: 1 } }), true);
            // With no Tips to pay it, the tool is not offered either: it could never be paid.
            assert.strictEqual(tool.available({ config: { services: { tipsUrl: '' } }, spend: { weekly: 1 } }), false);
        });

        await check('a run with no allowance asks for nothing and pays nothing', async () => {
            const before = t.providers.requests.length;
            const row = await askTip({ to: creator, amount: 12, reason: 'thanks for the stream' });
            assert.strictEqual(row.state, 'succeeded', JSON.stringify(row.error_detail));
            assert.strictEqual((await moneyApprovals()).length, 0, 'no approval was asked for');
            assert.strictEqual(tips.calls.length, 0, 'nothing was paid');
            // The tool was not in the model's list at all: with no allowance there is nothing to offer.
            const tools = t.providers.requests.slice(before)
                .filter((r) => r.path.endsWith('/chat/completions') && Array.isArray(r.body.tools))
                .flatMap((r) => r.body.tools.map((x) => x.function && x.function.name));
            assert.ok(tools.length > 0, 'the loop saw a tool list');
            assert.ok(!tools.includes('spend_vibes'), 'no allowance, no spending tool');
        });

        await check('a tip always asks, at every level, and no allow rule covers it', async () => {
            await spend.setAllowance(t.ctx.s, owner, agent.id, 50);
            // Full access: the level never skips the floor.
            await contacts.setLevel(t.ctx.s, t.config, owner, agent.id, 'full');
            const before = t.providers.requests.length;
            const row = await askTip({ to: creator, amount: 12, reason: 'thanks for the stream' });
            assert.strictEqual(row.state, 'succeeded', JSON.stringify(row.error_detail));
            const tools = t.providers.requests.slice(before)
                .filter((r) => r.path.endsWith('/chat/completions') && Array.isArray(r.body.tools))
                .flatMap((r) => r.body.tools.map((x) => x.function && x.function.name));
            assert.ok(tools.includes('spend_vibes'), 'an allowance offers the spending tool');
            const asks = await moneyApprovals();
            assert.strictEqual(asks.length, 1, 'the tip asked for approval');
            const ask = asks[0];
            assert.strictEqual(ask.state, 'pending');
            assert.strictEqual(ask.agent_id, agent.id);
            assert.strictEqual(tips.calls.length, 0, 'nothing was paid without the person');
            // The card always names the handle, and the usr_ id too because this tip named an id.
            assert.strictEqual(ask.summary, 'Tip 12 Vibes to Bo (@bo) · usr_01JZ7QK9F3M8N2P4R6T8V0X2YB: thanks for the stream');
            // A standing permission can never cover money, even one written by hand into the rules it reads.
            const rule = await allows.grant(t.ctx.s, owner, agent.id, 'money', 'tip 12 Vibes to x');
            assert.ok(rule.error, 'money is never always allowed');
            assert.strictEqual(allows.matches([], 'money', 'tip 12 Vibes to x'), false);
            assert.strictEqual(allows.matches([{ kind: 'money', target: 'tip 12 Vibes to x' }], 'money', 'tip 12 Vibes to x'), false, 'a money rule never matches');
            const stillAsks = await levels.decide({ level: 'full', categories: ['money'], allow: { kind: 'money', target: 'tip 12 Vibes to x', rules: [{ kind: 'money', target: 'tip 12 Vibes to x' }] } });
            assert.strictEqual(stillAsks.ask, true, 'the floor asks at full access even with a rule');
            // And the card says "approve and pay", never "always allow".
            const card = await t.get(`/me/approvals/${ask.id}`, { as: ada });
            assert.ok(card.text.includes('Approve and pay'), 'the card offers to pay');
            assert.ok(!card.text.includes('Always allow this'), 'money is never always allowed');
            assert.ok(card.text.includes('12 Vibes') && card.text.includes('thanks for the stream'), 'the card says the amount and the reason');
            assert.ok(card.text.includes('Bo (@bo)') && card.text.includes(creator), 'the card says who receives it, by handle and id');
            assert.ok(card.text.includes('Left this week'), 'the card says what is left this week');
            // A tip named by its handle names the handle, never an id the person did not ask to see.
            const byHandle = await spend.prepare({ config: t.config, s: t.ctx.s, owner, agentId: agent.id, payload: { to: '@bo', amount: 4 } });
            assert.ok(byHandle.ok, byHandle.message);
            assert.strictEqual(byHandle.summary, 'Tip 4 Vibes to Bo (@bo)');
            assert.ok(!byHandle.summary.includes(creator), 'a handle-named tip does not show the usr_ id');
            const byId = await spend.prepare({ config: t.config, s: t.ctx.s, owner, agentId: agent.id, payload: { to: creator, amount: 4 } });
            assert.ok(byId.summary.includes('Bo (@bo)') && byId.summary.includes(creator), 'an id-named tip shows the handle and the id');
            assert.ok(tips.views.includes('bo') && tips.views.includes(creator), 'each was looked up by the name the tip gave');
        });

        await check('a tip below the creator\'s minimum is refused before the person sees a card', async () => {
            const before = (await moneyApprovals()).length;
            const paidBefore = tips.calls.length;
            const row = await askTip({ to: 'nina', amount: 5, reason: 'too small' });
            assert.strictEqual(row.state, 'succeeded', JSON.stringify(row.error_detail));
            assert.strictEqual((await moneyApprovals()).length, before, 'no approval was created');
            assert.strictEqual(tips.calls.length, paidBefore, 'Tips was never asked to pay');
            const said = await t.ctx.s.db.many("SELECT body->>'text' AS text FROM task_events WHERE task_id = $1 AND body->>'step' = 'tool_result'", [row.id]);
            assert.ok(said.some((e) => e.text.includes('minimum for a tip is 10 Vibes')), 'the agent is told Tips\' own minimum');
        });

        await check('an ask over what is left of the allowance is refused before the person sees it', async () => {
            await spend.setAllowance(t.ctx.s, owner, agent.id, 5);
            const before = (await moneyApprovals()).length;
            const row = await askTip({ to: creator, amount: 40, reason: 'too much' });
            assert.strictEqual(row.state, 'succeeded', JSON.stringify(row.error_detail));
            assert.strictEqual((await moneyApprovals()).length, before, 'no approval was created');
            assert.strictEqual(tips.calls.length, 0, 'nothing was paid');
            // The model is told why in one plain line, and it never reaches the person's card.
            const said = await t.ctx.s.db.many("SELECT body->>'text' AS text FROM task_events WHERE task_id = $1 AND body->>'step' = 'tool_result'", [row.id]);
            assert.ok(said.some((e) => /left this week/.test(e.text || '')), 'the agent is told why in one line');
            assert.ok(said.some((e) => /this tip is 40/.test(e.text || '')), 'and how much was asked');
        });

        await check('approving pays once through Tips checkout, with the person\'s own token', async () => {
            await spend.setAllowance(t.ctx.s, owner, agent.id, 50);
            const ask = (await moneyApprovals()).find((a) => payloadOf(a).amount === 12);
            assert.ok(ask, 'the 12 Vibe tip is waiting');
            const res = await t.get(`/me/approvals/${ask.id}`, { as: ada, form: { decision: 'approve' }, headers: SAME });
            assert.strictEqual(res.status, 303, res.text.slice(0, 200));
            assert.strictEqual(tips.calls.length, 1, 'the tip was paid once');
            const call = tips.calls[0];
            assert.strictEqual(call.auth, `Bearer ${t.network.userToken(ada)}`, 'paid with the person\'s own token');
            assert.strictEqual(call.key, ask.id, 'the approval id is the idempotency key');
            assert.strictEqual(call.contentType, 'application/json');
            assert.deepStrictEqual(call.body, { creator, amount: 12, message: 'thanks for the stream', pay_with: 'credit' });
            assert.strictEqual((await approvals.get(t.ctx.s, owner, ask.id)).state, 'approved');
            const paid = await spend.paidFor(t.ctx.s, owner, ask.id);
            assert.ok(paid, 'the payment is recorded');
            assert.strictEqual(Number(paid.amount), 12);
            assert.strictEqual(paid.txn_id, tips.payments.get(ask.id).id, 'Tips\' interaction id is the record');
            // A second click never pays twice.
            const again = await t.get(`/me/approvals/${ask.id}`, { as: ada, form: { decision: 'approve' }, headers: SAME });
            assert.strictEqual(again.status, 409);
            assert.strictEqual(tips.calls.length, 1, 'still one payment');
        });

        await check('a tip over what is left at payment time is refused, not paid', async () => {
            await spend.setAllowance(t.ctx.s, owner, agent.id, 50);
            const ask = await approvals.request(t.ctx.s, {
                owner, agentId: agent.id, kind: 'money', summary: 'Tip 30 Vibes to Bo: over now',
                payload: { spend: 'tip', to: creator, to_label: 'Bo (@bo)', amount: 30, reason: 'over now' },
            });
            // The person lowers the allowance after the ask: the card may be older than the setting.
            await spend.setAllowance(t.ctx.s, owner, agent.id, 5);
            const before = tips.calls.length;
            try {
                const res = await t.get(`/me/approvals/${ask.id}`, { as: ada, form: { decision: 'approve' }, headers: SAME });
                assert.strictEqual(res.status, 200, res.text.slice(0, 200));
                assert.ok(res.text.includes('left this week'), 'the card says what is left');
                assert.strictEqual((await approvals.get(t.ctx.s, owner, ask.id)).state, 'pending');
                assert.strictEqual(tips.calls.length, before, 'Tips was never called');
                assert.strictEqual(await spend.paidFor(t.ctx.s, owner, ask.id), null);
            } finally {
                await spend.setAllowance(t.ctx.s, owner, agent.id, 50);
            }
            // The person may decline it, and no money moves.
            const declined = await t.get(`/me/approvals/${ask.id}`, { as: ada, form: { decision: 'decline' }, headers: SAME });
            assert.strictEqual(declined.status, 303);
        });

        await check('the payment is in the agent\'s activity, in the Action Center and in the export', async () => {
            const ask = (await moneyApprovals()).find((a) => payloadOf(a).amount === 12);
            assert.ok(ask, 'the paid tip is there');
            const page = await t.get(`/me/agents/${agent.id}`, { as: ada });
            assert.ok(page.text.includes('12 Vibes'), 'the agent\'s page shows what it spent');
            assert.ok(page.text.includes('Bo (@bo)'), 'and the handle of who received it');
            assert.ok(page.text.includes('thanks for the stream'), 'and why');
            // The Action Center: a first-party service with actor.actions.read reads the person's items.
            const now = Math.floor(Date.now() / 1000);
            const reader = serviceAuth.signServiceToken({ iss: t.network.url, sub: 'svc:network', actor_type: 'service', aud: ['openvibe.actor'], cap: ['actor.actions.read'], iat: now, exp: now + 300, jti: crypto.randomUUID() }, t.network.privatePem);
            const feed = await t.get(`/api/v1/actions?subject=${ada.subject}`, { bearer: reader });
            assert.strictEqual(feed.status, 200, feed.text.slice(0, 200));
            const items = feed.json().items || [];
            const item = items.find((i) => i.kind === 'approval' && String(i.summary || '').includes('12 Vibes'));
            assert.ok(item, 'the payment is an Action Center item');
            assert.strictEqual(item.bucket, 'done');
            // The export: the rows of the payments are the person's own.
            const { TABLES } = require('../server/identity/account-data');
            assert.ok(TABLES.some((x) => x.table === 'actor_spends'), 'the payments are in the export');
            const rows = await t.ctx.s.db.many('SELECT * FROM actor_spends WHERE owner = $1', [owner]);
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0].state, 'paid');
            assert.strictEqual(rows[0].txn_id, tips.payments.get(ask.id).id);
        });

        await check('a tip is never paid by a service, nor by approve-always', async () => {
            await spend.setAllowance(t.ctx.s, owner, agent.id, 50);
            const ask = await approvals.request(t.ctx.s, {
                owner, agentId: agent.id, kind: 'money', summary: 'Tip 5 Vibes to Bo: no service',
                payload: { spend: 'tip', to: creator, to_label: 'Bo (@bo)', amount: 5, reason: 'no service' },
            });
            const before = tips.calls.length;
            // The Action Center's service token has no person behind it: it can decline, never pay.
            const service = await approvals.decide(t.ctx, owner, ask.id, 'approve');
            assert.ok(service.error && service.pending, 'a service approval does not pay');
            assert.strictEqual((await approvals.get(t.ctx.s, owner, ask.id)).state, 'pending', 'and the request stays pending');
            // Even the person's own token cannot make a money step always-allowed.
            const always = await approvals.decide(t.ctx, owner, ask.id, 'approve_always', { personToken: t.network.userToken(ada) });
            assert.ok(always.error, 'approve-always is refused for money');
            assert.match(String(always.error), /always asks/);
            assert.strictEqual((await approvals.get(t.ctx.s, owner, ask.id)).state, 'pending');
            assert.strictEqual(tips.calls.length, before, 'nothing was paid');
            assert.strictEqual(await spend.paidFor(t.ctx.s, owner, ask.id), null);
            const declined = await approvals.decide(t.ctx, owner, ask.id, 'decline');
            assert.strictEqual(declined.row.state, 'declined');
        });

        await check('a definite refusal from Tips marks the claim failed and keeps the request pending', async () => {
            const ask = await approvals.request(t.ctx.s, {
                owner, agentId: agent.id, kind: 'money', summary: 'Tip 5 Vibes to Bo: another one',
                payload: { spend: 'tip', to: creator, to_label: 'Bo (@bo)', amount: 5, reason: 'another one' },
            });
            // Tips refuses this one: not enough Vibes (a 409, a definite answer: no money moved).
            const before = tips.calls.length;
            tips.state.refuse = { status: 409, code: 'billing.insufficient_funds', detail: 'Not enough Vibes on this account.' };
            try {
                const res = await t.get(`/me/approvals/${ask.id}`, { as: ada, form: { decision: 'approve' }, headers: SAME });
                assert.strictEqual(res.status, 200, res.text.slice(0, 200));
                assert.ok(res.text.includes('Not enough Vibes'), 'the reason is shown');
                assert.ok(res.text.includes('Approve and pay'), 'the card is still waiting');
                assert.strictEqual((await approvals.get(t.ctx.s, owner, ask.id)).state, 'pending', 'it stays pending');
                assert.strictEqual(await spend.paidFor(t.ctx.s, owner, ask.id), null, 'nothing was paid');
                assert.strictEqual(tips.calls.length, before + 1, 'Tips was asked once');
                const failed = await t.ctx.s.db.maybe("SELECT * FROM actor_spends WHERE approval_id = $1 AND state = 'failed'", [ask.id]);
                assert.ok(failed, 'the claim is kept as a failed attempt');
                // A refused attempt is not a payment: it does not eat into the week.
                assert.strictEqual((await spend.allowance(t.ctx.s, owner, agent.id)).spent, 12);
            } finally {
                tips.state.refuse = null;
            }
            // The person may try again once the cause is fixed.
            const retry = await t.get(`/me/approvals/${ask.id}`, { as: ada, form: { decision: 'approve' }, headers: SAME });
            assert.strictEqual(retry.status, 303, retry.text.slice(0, 200));
            assert.strictEqual(tips.calls.length, before + 2, 'the retry asked Tips again');
            assert.ok(await spend.paidFor(t.ctx.s, owner, ask.id), 'the retry paid once');
            assert.strictEqual((await approvals.get(t.ctx.s, owner, ask.id)).state, 'approved');
            assert.strictEqual((await spend.allowance(t.ctx.s, owner, agent.id)).spent, 17, 'only the payment counts');
        });

        await check('every 4xx from Tips is definite (no money moved), except an idempotency claim still in progress', async () => {
            const answer = (status, code = null) => async () => new Response(JSON.stringify({ code, detail: `answered ${status}` }), { status, headers: { 'content-type': 'application/json' } });
            const tipWith = (fetchImpl) => spend.createTips({ config: { services: { tipsUrl: 'https://tips.example' } }, fetchImpl })
                .tip({ token: 'tok', to: creator, amount: 5, key: 'apr_x' });
            for (const [status, code] of [[401, 'token.invalid'], [403, null], [404, 'tips.no_creator'], [409, 'billing.insufficient_funds'], [422, null], [429, 'rate.limited']]) {
                const out = await tipWith(answer(status, code));
                assert.strictEqual(out.definite, true, `${status} is definite`);
                assert.ok(!out.unknown, `${status} is not unknown`);
            }
            for (const [status, code] of [[409, 'idempotency.in_progress'], [500, null], [502, null], [503, null]]) {
                const out = await tipWith(answer(status, code));
                assert.strictEqual(out.unknown, true, `${status} ${code || ''} is unknown: it keeps counting`);
            }
            const thrown = await tipWith(async () => { throw new Error('socket hang up'); });
            assert.strictEqual(thrown.unknown, true, 'no answer at all is unknown');
        });

        await check('an unknown answer keeps the claim paying, counts it, and a retry after the stale window replays it once', async () => {
            const goodTips = t.ctx.tips;
            t.ctx.tips = spend.createTips({ config: t.config, fetchImpl: globalThis.fetch, timeoutMs: 80 });
            const ask = await approvals.request(t.ctx.s, {
                owner, agentId: agent.id, kind: 'money', summary: 'Tip 7 Vibes to Bo: maybe',
                payload: { spend: 'tip', to: creator, to_label: 'Bo (@bo)', amount: 7, reason: 'maybe' },
            });
            const before = tips.calls.length;
            tips.state.delayMs = 400;   // the first request outlives the client's 80 ms: Tips records it, Actor cannot know
            try {
                const res = await t.get(`/me/approvals/${ask.id}`, { as: ada, form: { decision: 'approve' }, headers: SAME });
                assert.strictEqual(res.status, 200, res.text.slice(0, 200));
                assert.ok(res.text.includes(UNCONFIRMED), 'the person is told the tip is not confirmed');
                assert.strictEqual((await approvals.get(t.ctx.s, owner, ask.id)).state, 'pending', 'the card stays pending');
                assert.strictEqual(await spend.paidFor(t.ctx.s, owner, ask.id), null, 'nothing is recorded as paid yet');
                const paying = await t.ctx.s.db.maybe("SELECT * FROM actor_spends WHERE approval_id = $1", [ask.id]);
                assert.ok(paying, 'the claim is kept');
                assert.strictEqual(paying.state, 'paying', 'an unknown answer is not a failure');
                assert.strictEqual((await spend.allowance(t.ctx.s, owner, agent.id)).spent, 24, 'the paying claim counts against the week');
                // Turning the allowance off after the fact must not strand a payment that may already have moved.
                await spend.setAllowance(t.ctx.s, owner, agent.id, 0);
            } finally {
                tips.state.delayMs = 0;
            }
            // The first request finished at Tips (and recorded its interaction), though Actor never heard the answer.
            await new Promise((r) => setTimeout(r, 500));
            // After the stale window the same approval pays again: the same key, so Tips replays the one interaction.
            now += 6 * 60_000;
            t.ctx.tips = goodTips;
            const retry = await t.get(`/me/approvals/${ask.id}`, { as: ada, form: { decision: 'approve' }, headers: SAME });
            assert.strictEqual(retry.status, 303, retry.text.slice(0, 200));
            assert.strictEqual((await approvals.get(t.ctx.s, owner, ask.id)).state, 'approved');
            const paid = await spend.paidFor(t.ctx.s, owner, ask.id);
            assert.ok(paid, 'the tip settled once');
            assert.strictEqual(paid.txn_id, tips.payments.get(ask.id).id, 'the replayed interaction is the record');
            assert.strictEqual((await spend.allowance(t.ctx.s, owner, agent.id)).spent, 24, 'the same payment did not count twice');
            const attempts = tips.calls.slice(before);
            assert.strictEqual(attempts.length, 2, 'the retry called Tips once more');
            assert.strictEqual(attempts[0].key, ask.id);
            assert.strictEqual(attempts[1].key, ask.id, 'the retry sends the same Idempotency-Key');
            assert.deepStrictEqual(attempts[1].body, attempts[0].body, 'with the same body');
            assert.strictEqual((await t.ctx.s.db.many("SELECT * FROM actor_spends WHERE approval_id = $1 AND state = 'paid'", [ask.id])).length, 1);
        });

        await check('two clicks at once pay once', async () => {
            await spend.setAllowance(t.ctx.s, owner, agent.id, 50);
            const ask = await approvals.request(t.ctx.s, {
                owner, agentId: agent.id, kind: 'money', summary: 'Tip 3 Vibes to Bo: together',
                payload: { spend: 'tip', to: creator, to_label: 'Bo (@bo)', amount: 3, reason: 'together' },
            });
            const before = tips.calls.length;
            const personToken = t.network.userToken(ada);
            await Promise.all([
                approvals.decide(t.ctx, owner, ask.id, 'approve', { personToken }),
                approvals.decide(t.ctx, owner, ask.id, 'approve', { personToken }),
            ]);
            assert.strictEqual(tips.calls.length, before + 1, 'Tips was called once for two clicks');
            assert.strictEqual((await approvals.get(t.ctx.s, owner, ask.id)).state, 'approved');
            assert.ok(await spend.paidFor(t.ctx.s, owner, ask.id), 'the tip was paid');
            const paidRows = await t.ctx.s.db.many("SELECT * FROM actor_spends WHERE approval_id = $1 AND state = 'paid'", [ask.id]);
            assert.strictEqual(paidRows.length, 1, 'one payment row for two clicks');
        });
    } catch (err) {
        process.stdout.write(`  ✗ the suite threw\n      ${(err.stack || String(err)).split('\n').slice(0, 8).join('\n      ')}\n`);
        process.exitCode = 1;
    } finally {
        await t.close();
        await tips.close();
    }
    done();
})();
