import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const kv = (init = {}) => { const m = new Map(Object.entries(init)); return { m, put: async (k, v) => m.set(k, v), get: async (k) => m.get(k) ?? null, delete: async (k) => m.delete(k) }; };
const env = (extra = {}) => ({
  SALLA_APP_ID: '9451629279', SALLA_INTROSPECT_URL: 'https://i.test/introspect', SALLA_API_BASE: 'https://api.test',
  TOKENS: kv({ 'merchant:346539387': JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_at: Date.now() + 3600e3 }) }), ...extra
});
const ok = (data, pagination) => new Response(JSON.stringify({ status: 200, success: true, data, pagination }), { headers: { 'content-type': 'application/json' } });

function mockFetch(introspectData) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); calls.push([u, init]);
    if (u.startsWith('https://i.test/introspect')) return introspectData ? ok(introspectData) : new Response('{}', { status: 401 });
    if (u.startsWith('https://api.test/orders')) return ok([{ id: 1, reference_id: 500, total: { amount: 100, currency: 'SAR' }, date: { date: '2026-10-01 10:00:00.000000' },
      status: { slug: 'completed' }, items: [{ name: 'Dress', quantity: 2, thumbnail: null }], customer: { full_name: 'سارة' } },
      { id: 2, reference_id: 501, total: { amount: 50 }, date: { date: '2026-10-01 11:00:00.000000' }, status: { slug: 'payment_pending' }, items: [] }], { totalPages: 1 });
    if (u.startsWith('https://api.test/shipments')) return ok([{ id: 's1', courier_name: 'SMSA', status: 'delivered', payment_method: 'pre_paid', ship_to: { city: 'جدة' } }, { id: 's2', courier_name: 'SMSA', status: 'lost' }], { totalPages: 1 });
    if (u.startsWith('https://api.test/coupons')) return ok([{ id: 1, code: 'A', type: 'fixed', status: 'active', amount: { amount: 10 } }, { id: 2, code: 'B', status: 'deleted', amount: { amount: 5 } }], { totalPages: 1 });
    if (u.startsWith('https://api.test/customers')) return ok([], u.includes('date_from') ? { total: 7 } : { total: 120 });
    if (u.startsWith('https://api.test/products/quantities')) {
      const pg = Number(new URL(u).searchParams.get('page'));
      return ok([{ id: pg, name: 'P' + pg, quantity: 3, sold_quantity: 9, price: '10.00', unlimited_quantity: false, variant: null, sku: null, image: null }], { totalPages: 2 });
    }
    if (u.startsWith('https://api.test/products')) return ok([{ name: 'Dress', price: { amount: 60 }, sale_price: { amount: 45 }, thumbnail: 't.png' }], { totalPages: 1 });
    throw new Error('unexpected fetch ' + u);
  };
  return calls;
}
const good = { merchant_id: 346539387, user_id: 1, exp: '2999-01-01T00:00:00Z' };
const req = () => new Request('https://x.test/api/orders?from=2026-10-01&to=2026-10-02', { headers: { authorization: 'Bearer tok' } });

test('orders: introspect headers/body (S-Source, token only), skips unpaid, prices from catalog', async () => {
  const calls = mockFetch(good);
  const res = await worker.fetch(req(), env());
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.orders.length, 1);
  assert.deepEqual([j.orders[0].lines[0].price, j.pricesEstimated], [45, false]);
  const [, init] = calls[0];
  assert.equal(init.headers['s-source'], '9451629279');
  assert.deepEqual(JSON.parse(init.body), { token: 'tok' });
  assert.equal(calls.find(([u]) => u.startsWith('https://api.test/orders'))[1].headers.authorization, 'Bearer AT');
});
test('orders: rejects token of another app, expired token, and invalid token', async () => {
  for (const data of [{ ...good, app_id: 1 }, { ...good, exp: '2000-01-01T00:00:00Z' }, null]) {
    mockFetch(data);
    assert.equal((await worker.fetch(req(), env())).status, 401);
  }
});
test('orders: 403 when app not installed for that store', async () => {
  mockFetch({ ...good, merchant_id: 999 });
  assert.equal((await worker.fetch(req(), env())).status, 403);
});

test('inventory: pages through Product Quantities and normalizes', async () => {
  mockFetch(good);
  const res = await worker.fetch(new Request('https://x.test/api/inventory', { headers: { authorization: 'Bearer tok' } }), env());
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.deepEqual(j.items.map((i) => [i.name, i.qty, i.sold, i.price]), [['P1', 3, 9, 10], ['P2', 3, 9, 10]]);
  mockFetch(null);
  assert.equal((await worker.fetch(new Request('https://x.test/api/inventory', { headers: { authorization: 'Bearer bad' } }), env())).status, 401);
});

test('coupons: skips deleted; customers: total + in-range', async () => {
  mockFetch(good);
  const h = { headers: { authorization: 'Bearer tok' } };
  const c = await (await worker.fetch(new Request('https://x.test/api/coupons', h), env())).json();
  assert.deepEqual(c.coupons.map((x) => x.code), ['A']);
  const cu = await (await worker.fetch(new Request('https://x.test/api/customers?from=2026-10-01&to=2026-10-31', h), env())).json();
  assert.deepEqual(cu, { total: 120, inRange: 7 });
  const bad = await worker.fetch(new Request('https://x.test/api/customers?from=x&to=y', h), env());
  assert.equal(bad.status, 400);
});

test('shipments: normalized with groups, range validated', async () => {
  mockFetch(good);
  const h = { headers: { authorization: 'Bearer tok' } };
  const j = await (await worker.fetch(new Request('https://x.test/api/shipments?from=2026-10-01&to=2026-10-31', h), env())).json();
  assert.deepEqual(j.shipments.map((s) => [s.courier, s.group]), [['SMSA', 'delivered'], ['SMSA', 'failed']]);
  assert.equal((await worker.fetch(new Request('https://x.test/api/shipments?from=1&to=2', h), env())).status, 400);
});
