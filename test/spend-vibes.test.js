'use strict';
/**
 * HO7: an agent that can spend the person's Vibes.
 *
 * The tool is only offered to an agent whose person set a weekly allowance. A tip always asks (money is the floor:
 * no level and no "always allow" rule covers it), and the money moves only when the person approves the card with
 * their own session, once, with their own token. An ask over what is left of the allowance is refused before the
 * person ever sees it, and a refusal from Billing leaves the request pending with its reason.
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

/** A stand-in for OpenVibe.Billing: the one route a person's own token pays a tip on. */
async function startBilling() {
    const calls = [];
    // state.refuse is what Billing answers with, when a test wants it to refuse.
    const state = { refuse: null };
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/problem+json' }); res.end(JSON.stringify(obj)); };
            if (req.url !== '/api/me/vibes/tips') return json(404, { code: 'not_found', detail: 'no such route' });
            const body = raw ? JSON.parse(raw) : {};
            calls.push({ auth: req.headers.authorization || null, key: req.headers['idempotency-key'] || null, body });
            const refusal = typeof state.refuse === 'function' ? state.refuse(calls.length, body) : state.refuse;
            if (refusal) return json(refusal.status || 409, refusal);
            return json(201, { transaction: { id: `txn_${String(calls.length).padStart(26, '0')}`, amount: body.amount, status: 'settled' } });
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, state, close: () => new Promise((r) => server.close(r)) };
}

/** A stand-in for OpenVibe.Tips: a creator's page, by name. */
async function startTips({ creators = {} } = {}) {
    const calls = [];
    const server = http.createServer((req, res) => {
        const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        const m = /^\/api\/v1\/profiles\/([^/?]+)$/.exec(req.url);
        if (!m) return json(404, { error: 'not_found' });
        const handle = decodeURIComponent(m[1]);
        calls.push(handle);
        const c = creators[handle];
        if (!c) return json(404, { error: 'not_found' });
        return json(200, { profile: { creator: { type: 'user', id: c.subject }, handle, display_name: c.name || handle } });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

/** The model turn that asks for the tip, and the answer that follows it. */
const tipTurn = (args) => ({ content: 'Tipping the creator.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'spend_vibes', arguments: JSON.stringify(args) } }] });
const doneTurn = { content: 'The tip was sent.' };

(async () => {
    const billing = await startBilling();
    const tips = await startTips({ creators: { bo: { subject: 'usr_01JZ7QK9F3M8N2P4R6T8V0X2YB', name: 'Bo' } } });
    const t = await boot({
        env: { ACTOR_BILLING_URL: billing.url, ACTOR_TIPS_URL: tips.url },
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
            // With no Billing to pay it, the tool is not offered either: it could never be paid.
            assert.strictEqual(tool.available({ config: { services: { billingUrl: '' } }, spend: { weekly: 1 } }), false);
        });

        await check('a run with no allowance asks for nothing and pays nothing', async () => {
            const before = t.providers.requests.length;
            const row = await askTip({ to: creator, amount: 12, reason: 'thanks for the stream' });
            assert.strictEqual(row.state, 'succeeded', JSON.stringify(row.error_detail));
            assert.strictEqual((await moneyApprovals()).length, 0, 'no approval was asked for');
            assert.strictEqual(billing.calls.length, 0, 'nothing was paid');
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
            assert.strictEqual(billing.calls.length, 0, 'nothing was paid without the person');
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
            assert.ok(card.text.includes('Bo') && card.text.includes(creator), 'the card says who receives it');
            assert.ok(card.text.includes('Left this week'), 'the card says what is left this week');
        });

        await check('an ask over what is left of the allowance is refused before the person sees it', async () => {
            await spend.setAllowance(t.ctx.s, owner, agent.id, 5);
            const before = (await moneyApprovals()).length;
            const row = await askTip({ to: creator, amount: 40, reason: 'too much' });
            assert.strictEqual(row.state, 'succeeded', JSON.stringify(row.error_detail));
            assert.strictEqual((await moneyApprovals()).length, before, 'no approval was created');
            assert.strictEqual(billing.calls.length, 0, 'nothing was paid');
            // The model is told why in one plain line, and it never reaches the person's card.
            const said = await t.ctx.s.db.many("SELECT body->>'text' AS text FROM task_events WHERE task_id = $1 AND body->>'step' = 'tool_result'", [row.id]);
            assert.ok(said.some((e) => /left this week/.test(e.text || '')), 'the agent is told why in one line');
            assert.ok(said.some((e) => /this tip is 40/.test(e.text || '')), 'and how much was asked');
        });

        await check('approving pays once, with the person\'s own token', async () => {
            await spend.setAllowance(t.ctx.s, owner, agent.id, 50);
            const ask = (await moneyApprovals()).find((a) => payloadOf(a).amount === 12);
            assert.ok(ask, 'the 12 Vibe tip is waiting');
            const res = await t.get(`/me/approvals/${ask.id}`, { as: ada, form: { decision: 'approve' }, headers: SAME });
            assert.strictEqual(res.status, 303, res.text.slice(0, 200));
            assert.strictEqual(billing.calls.length, 1, 'the tip was paid once');
            const call = billing.calls[0];
            assert.strictEqual(call.auth, `Bearer ${t.network.userToken(ada)}`, 'paid with the person\'s own token');
            assert.strictEqual(call.key, ask.id, 'the approval id is the idempotency key');
            assert.strictEqual(call.body.to, creator);
            assert.strictEqual(call.body.amount, 12);
            assert.strictEqual(call.body.message, 'thanks for the stream');
            assert.strictEqual((await approvals.get(t.ctx.s, owner, ask.id)).state, 'approved');
            const paid = await spend.paidFor(t.ctx.s, owner, ask.id);
            assert.ok(paid, 'the payment is recorded');
            assert.strictEqual(Number(paid.amount), 12);
            // A second click never pays twice.
            const again = await t.get(`/me/approvals/${ask.id}`, { as: ada, form: { decision: 'approve' }, headers: SAME });
            assert.strictEqual(again.status, 409);
            assert.strictEqual(billing.calls.length, 1, 'still one payment');
        });

        await check('a tip over what is left at payment time is refused, not paid', async () => {
            await spend.setAllowance(t.ctx.s, owner, agent.id, 50);
            const ask = await approvals.request(t.ctx.s, {
                owner, agentId: agent.id, kind: 'money', summary: 'Tip 30 Vibes to Bo: over now',
                payload: { spend: 'tip', to: creator, to_label: 'Bo', amount: 30, reason: 'over now' },
            });
            // The person lowers the allowance after the ask: the card may be older than the setting.
            await spend.setAllowance(t.ctx.s, owner, agent.id, 5);
            const before = billing.calls.length;
            try {
                const res = await t.get(`/me/approvals/${ask.id}`, { as: ada, form: { decision: 'approve' }, headers: SAME });
                assert.strictEqual(res.status, 200, res.text.slice(0, 200));
                assert.ok(res.text.includes('left this week'), 'the card says what is left');
                assert.strictEqual((await approvals.get(t.ctx.s, owner, ask.id)).state, 'pending');
                assert.strictEqual(billing.calls.length, before, 'Billing was never called');
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
        });

        await check('a tip is never paid by a service, nor by approve-always', async () => {
            await spend.setAllowance(t.ctx.s, owner, agent.id, 50);
            const ask = await approvals.request(t.ctx.s, {
                owner, agentId: agent.id, kind: 'money', summary: 'Tip 5 Vibes to Bo: no service',
                payload: { spend: 'tip', to: creator, to_label: 'Bo', amount: 5, reason: 'no service' },
            });
            const before = billing.calls.length;
            // The Action Center's service token has no person behind it: it can decline, never pay.
            const service = await approvals.decide(t.ctx, owner, ask.id, 'approve');
            assert.ok(service.error && service.pending, 'a service approval does not pay');
            assert.strictEqual((await approvals.get(t.ctx.s, owner, ask.id)).state, 'pending', 'and the request stays pending');
            // Even the person's own token cannot make a money step always-allowed.
            const always = await approvals.decide(t.ctx, owner, ask.id, 'approve_always', { personToken: t.network.userToken(ada) });
            assert.ok(always.error, 'approve-always is refused for money');
            assert.match(String(always.error), /always asks/);
            assert.strictEqual((await approvals.get(t.ctx.s, owner, ask.id)).state, 'pending');
            assert.strictEqual(billing.calls.length, before, 'nothing was paid');
            assert.strictEqual(await spend.paidFor(t.ctx.s, owner, ask.id), null);
            const declined = await approvals.decide(t.ctx, owner, ask.id, 'decline');
            assert.strictEqual(declined.row.state, 'declined');
        });

        await check('a refusal from Billing keeps the request pending and shows its reason', async () => {
            billing.calls.length = 0;
            const ask = await approvals.request(t.ctx.s, {
                owner, agentId: agent.id, kind: 'money', summary: 'Tip 5 Vibes to Bo: another one',
                payload: { spend: 'tip', to: creator, to_label: 'Bo', amount: 5, reason: 'another one' },
            });
            // Billing refuses this one: not enough Vibes.
            billing.state.refuse = { status: 409, code: 'billing.insufficient_funds', detail: 'Not enough Vibes on this account.' };
            try {
                const res = await t.get(`/me/approvals/${ask.id}`, { as: ada, form: { decision: 'approve' }, headers: SAME });
                assert.strictEqual(res.status, 200, res.text.slice(0, 200));
                assert.ok(res.text.includes('Not enough Vibes'), 'the reason is shown');
                assert.ok(res.text.includes('Approve and pay'), 'the card is still waiting');
                assert.strictEqual((await approvals.get(t.ctx.s, owner, ask.id)).state, 'pending', 'it stays pending');
                assert.strictEqual(await spend.paidFor(t.ctx.s, owner, ask.id), null, 'nothing was paid');
                assert.strictEqual(billing.calls.length, 1, 'Billing was asked once');
                // A refused attempt is not a payment: it does not eat into the week.
                assert.strictEqual((await spend.allowance(t.ctx.s, owner, agent.id)).spent, 12);
            } finally {
                billing.state.refuse = null;
            }
            // The person may try again once the cause is fixed.
            const retry = await t.get(`/me/approvals/${ask.id}`, { as: ada, form: { decision: 'approve' }, headers: SAME });
            assert.strictEqual(retry.status, 303, retry.text.slice(0, 200));
            assert.strictEqual(billing.calls.length, 2, 'the retry asked Billing again');
            assert.ok(await spend.paidFor(t.ctx.s, owner, ask.id), 'the retry paid once');
            assert.strictEqual((await approvals.get(t.ctx.s, owner, ask.id)).state, 'approved');
            assert.strictEqual((await spend.allowance(t.ctx.s, owner, agent.id)).spent, 17, 'only the payment counts');
        });

        await check('two clicks at once pay once', async () => {
            await spend.setAllowance(t.ctx.s, owner, agent.id, 50);
            const ask = await approvals.request(t.ctx.s, {
                owner, agentId: agent.id, kind: 'money', summary: 'Tip 3 Vibes to Bo: together',
                payload: { spend: 'tip', to: creator, to_label: 'Bo', amount: 3, reason: 'together' },
            });
            const before = billing.calls.length;
            const personToken = t.network.userToken(ada);
            await Promise.all([
                approvals.decide(t.ctx, owner, ask.id, 'approve', { personToken }),
                approvals.decide(t.ctx, owner, ask.id, 'approve', { personToken }),
            ]);
            assert.strictEqual(billing.calls.length, before + 1, 'Billing was called once for two clicks');
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
        await billing.close();
        await tips.close();
    }
    done();
})();
