import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { __clearMemo, syncAll } from '../src/worker.js';
import { makeD1, makeKV } from './helpers.js';
import { ensureSchema, upsertDays, upsertInventory, setMeta } from '../src/db.js';
import { emptyDay, addOrder, roundDay } from '../src/agg.js';
import { normalizeOrder } from '../src/salla.js';
import { clearPriceCache, riyadhDay } from '../src/sync.js';

const tokens = JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_at: Date.now() + 3600e3 });
const mkEnv = () => ({ SALLA_APP_ID: '9451629279', SALLA_INTROSPECT_URL: 'https://i.test/introspect', SALLA_API_BASE: 'https://api.test', DB: makeD1(), TOKENS: makeKV({ 'merchant:346539387': tokens }), SYNC_BUDGET: '40' });
const ok = (data, pagination) => new Response(JSON.stringify({ status: 200, success: true, data, pagination }), { headers: { 'content-type': 'application/json' } });
const good = { merchant_id: 346539387, user_id: 1, exp: '2999-01-01T00:00:00Z' };
const auth = { headers: { authorization: 'Bearer tok' } };
const get = (env, path) => worker.fetch(new Request('https://x.test' + path, auth), env);

function mockFetch(introspect, routes = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); calls.push([u, init]);
    if (u.startsWith('https://i.test/introspect')) return introspect ? ok(undefined) && new Response(JSON.stringify({ status: 200, success: true, data: introspect }), { headers: { 'content-type': 'application/json' } }) : new Response('{}', { status: 401 });
    for (const [prefix, fn] of Object.entries(routes)) if (u.startsWith('https://api.test' + prefix)) return fn(u, init);
    throw new Error('unexpected fetch ' + u);
  };
  return calls;
}
beforeEach(() => { __clearMemo(); clearPriceCache(); });

const seedDay = async (env, day, orders) => {
  await ensureSchema(env.DB);
  const d = emptyDay(day);
  for (const o of orders) addOrder(d, normalizeOrder({ id: 1, reference_id: 1, total: { amount: o.t }, date: { date: `${day} ${o.h || 10}:00:00.000000` }, status: { slug: o.s || 'completed' },
    items: o.items || [{ name: 'Dress', quantity: 1 }], payment_method: 'mada', customer: { id: 1, city: 'جدة' }, source: 'store' }));
  await upsertDays(env.DB, '346539387', [roundDay(d)]);
};

test('summary: current vs previous period from daily aggregates; auth enforced', async () => {
  const env = mkEnv(); mockFetch(good);
  await seedDay(env, '2026-10-10', [{ t: 100 }, { t: 50, s: 'canceled' }]);
  await seedDay(env, '2026-10-11', [{ t: 200 }]);
  await seedDay(env, '2026-10-12', [{ t: 300 }, { t: 100 }]);
  await setMeta(env.DB, '346539387', 'state', { currency: 'SAR', backfillDone: true, invDoneOnce: true });
  const j = await (await get(env, '/api/summary?from=2026-10-11&to=2026-10-12')).json();
  assert.deepEqual([j.cur.revenue, j.cur.orders, j.cur.valid, j.cur.aov], [600, 3, 3, 200]);
  assert.deepEqual([j.prev.revenue, j.prev.orders, j.prev.lost], [100, 2, 1]);   // 9–10 أكتوبر
  assert.deepEqual(j.series, [['2026-10-11', 1, 200], ['2026-10-12', 2, 400]]);
  assert.equal(j.cur.products[0].name, 'Dress');
  assert.equal(j.sync.oldest, '2026-10-10'); assert.equal(j.sync.backfillDone, true);
  assert.equal((await worker.fetch(new Request('https://x.test/api/summary?from=x&to=y', auth), env)).status, 400);
  assert.equal((await worker.fetch(new Request('https://x.test/api/summary?from=2020-01-01&to=2026-10-12', auth), env)).status, 400);
  mockFetch({ ...good, merchant_id: 999 });
  __clearMemo();
  assert.equal((await get(env, '/api/summary?from=2026-10-11&to=2026-10-12')).status, 403);
  mockFetch(null); __clearMemo();
  assert.equal((await get(env, '/api/summary?from=2026-10-11&to=2026-10-12')).status, 401);
});

test('introspection: rejects other-app and expired tokens; result is cached briefly', async () => {
  const env = mkEnv();
  for (const data of [{ ...good, app_id: 1 }, { ...good, exp: '2000-01-01T00:00:00Z' }]) {
    mockFetch(data); __clearMemo();
    assert.equal((await get(env, '/api/recent')).status, 401);
  }
  const c2 = mockFetch(good, { '/orders': () => ok([], { totalPages: 1 }), '/coupons': () => ok([], { totalPages: 1 }) }); __clearMemo();
  await get(env, '/api/recent'); await get(env, '/api/coupons');
  assert.equal(c2.filter(([u]) => u.startsWith('https://i.test')).length, 1);   // نفس التوكن: تحقق واحد
});

test('recent: 30 newest orders, priced from inventory table, drafts and unpaid skipped', async () => {
  const env = mkEnv(); await ensureSchema(env.DB);
  await upsertInventory(env.DB, '346539387', 1, [{ id: 1, skuId: 0, name: 'Dress', price: 45, img: 'i.png', qty: 3, sold: 1, unlimited: false }]);
  const calls = mockFetch(good, { '/orders': () => ok([
    { id: 1, reference_id: 11, total: { amount: 90 }, date: { date: '2026-10-12 10:00:00.000000' }, status: { slug: 'completed' }, items: [{ name: 'Dress', quantity: 2 }], customer: { full_name: 'سارة' } },
    { id: 2, reference_id: 12, total: { amount: 50 }, date: { date: '2026-10-12 09:00:00.000000' }, status: { slug: 'payment_pending' }, items: [] }], { totalPages: 1 }) });
  const j = await (await get(env, '/api/recent')).json();
  assert.equal(j.orders.length, 1);
  assert.deepEqual([j.orders[0].lines[0].price, j.orders[0].lines[0].img], [45, 'i.png']);
  const q = new URL(calls.find(([u]) => u.includes('/orders'))[0]).searchParams;
  assert.deepEqual([q.get('per_page'), q.get('sort_by')], ['30', 'created_at-desc']);
});

test('inventory: served from D1; coupons/customers/shipments from Salla', async () => {
  const env = mkEnv(); await ensureSchema(env.DB);
  await upsertInventory(env.DB, '346539387', 1, [{ id: 7, skuId: 1, name: 'A', price: 10, qty: 0, sold: 3, unlimited: false }]);
  await setMeta(env.DB, '346539387', 'state', { invDoneOnce: true, invUpdatedAt: 123 });
  const calls = mockFetch(good, {
    '/coupons': () => ok([{ id: 1, code: 'A', type: 'fixed', status: 'active', amount: { amount: 10 } }, { id: 2, code: 'B', status: 'deleted', amount: { amount: 5 } }], { totalPages: 1 }),
    '/customers': (u) => ok([], u.includes('date_from') ? { total: 7 } : { total: 120 }),
    '/shipments': () => ok([{ id: 's1', courier_name: 'SMSA', status: 'delivered' }, { id: 's2', courier_name: 'SMSA', status: 'lost' }], { totalPages: 1 })
  });
  const inv = await (await get(env, '/api/inventory')).json();
  assert.deepEqual([inv.items.length, inv.complete, inv.updatedAt], [1, true, 123]);
  assert.deepEqual((await (await get(env, '/api/coupons')).json()).coupons.map((c) => c.code), ['A']);
  assert.deepEqual(await (await get(env, '/api/customers?from=2026-10-01&to=2026-10-31')).json(), { total: 120, inRange: 7 });
  assert.equal((await get(env, '/api/customers?from=1&to=2')).status, 400);
  const sh = await (await get(env, '/api/shipments')).json();
  assert.deepEqual(sh.shipments.map((s) => [s.courier, s.group]), [['SMSA', 'delivered'], ['SMSA', 'failed']]);
  const q = new URL(calls.find(([u]) => u.includes('/shipments'))[0]).searchParams;
  assert.equal(q.get('to'), null); assert.equal(q.get('to_date'), riyadhDay(Date.now()));
});

test('cron: syncAll runs every installed merchant', async () => {
  const env = mkEnv();
  mockFetch(good, {
    '/products/quantities': () => ok([{ id: 1, name: 'Dress', quantity: 1, sold_quantity: 0, price: '10', unlimited_quantity: false }], { totalPages: 1 }),
    '/orders': () => ok([], { totalPages: 1 })
  });
  const out = await syncAll(env, Date.parse('2026-10-12T09:00:00Z'));
  assert.equal(out.length, 1);
  assert.ok(out[0][1].log.includes('inventory'), JSON.stringify(out));
});
