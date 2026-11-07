import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { __clearMemo, syncAll } from '../src/worker.js';
import { makeD1, makeKV } from './helpers.js';
import { ensureSchema, upsertDays, upsertInventory, setMeta, upsertOrderRows, setAttr } from '../src/db.js';
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
  assert.deepEqual(j.series.map((x) => x.slice(0, 3)), [['2026-10-11', 1, 200], ['2026-10-12', 2, 400]]);
  assert.deepEqual(j.series[0].slice(3), [0, 0, 0, 0]);
  assert.deepEqual([j.cur.lostDetail.canceled.count, j.cur.lostDetail.refunded.count], [0, 0]);
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
    '/shipments': () => ok([{ id: 's1', courier_name: 'SMSA', status: 'delivered' }, { id: 's2', courier_name: 'SMSA', status: 'lost' }], { totalPages: 1 })
  });
  const inv = await (await get(env, '/api/inventory')).json();
  assert.deepEqual([inv.items.length, inv.complete, inv.updatedAt], [1, true, 123]);
  assert.deepEqual((await (await get(env, '/api/coupons')).json()).coupons.map((c) => c.code), ['A']);
  assert.deepEqual(await (await get(env, '/api/customers?from=2026-10-01&to=2026-10-31')).json(), { total: 0, active: 0, fresh: 0, returning: 0, backfillDone: false, error: '' });   // العملاء من جدول cust_day، لا من سلة
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

test('missing Salla scope returns 403 (not 502)', async () => {
  const env = mkEnv();
  mockFetch(good, { '/shipments': () => new Response('{}', { status: 403 }) });
  assert.equal((await get(env, '/api/shipments')).status, 403);
  mockFetch(good, { '/shipments': () => new Response('{}', { status: 500 }) }); __clearMemo();
  assert.equal((await get(env, '/api/shipments')).status, 502);
});

test('summary includes campaign stats from stored order attribution', async () => {
  const env = mkEnv(); mockFetch(good); await ensureSchema(env.DB);
  const M = '346539387';
  await upsertOrderRows(env.DB, M, [
    { id: 1, day: '2026-10-12', status: 'completed', total: 100 }, { id: 2, day: '2026-10-12', status: 'completed', total: 50 },
    { id: 3, day: '2026-10-12', status: 'canceled', total: 70 }, { id: 4, day: '2026-10-12', status: 'shipping', total: 30 }]);
  await setAttr(env.DB, M, [{ id: 1, src: 'instagram', med: 'paid', camp: 'C1' }, { id: 2, src: '', med: '', camp: '' }, { id: 3, src: 'instagram', med: '', camp: 'C1' }]);
  const j = await (await get(env, '/api/summary?from=2026-10-12&to=2026-10-12')).json();
  const c = j.campaigns;
  assert.deepEqual(c.sources.map((x) => [x.k, x.orders, x.total]), [['instagram', 1, 100], ['', 1, 50]]);   // الملغي مستبعد
  assert.deepEqual(c.campaigns.map((x) => [x.src, x.camp, x.total]), [['instagram', 'C1', 100]]);
  assert.deepEqual([c.attributed, c.total], [2, 3]);                                                            // طلب الشحن بلا إسناد بعد
  assert.ok(c.since);
});

test('share links: create/list/revoke with embedded token; read-only summary via Share; expiry; no minting', async () => {
  const env = mkEnv(); mockFetch(good);
  await seedDay(env, '2026-10-10', [{ t: 100 }]);
  const call = (path, init = {}, hdr = auth.headers) => worker.fetch(new Request('https://x.test' + path, { ...init, headers: { ...hdr, ...(init.headers || {}) } }), env);
  const c = await (await call('/api/share', { method: 'POST', body: JSON.stringify({ label: 'شريك', days: 7 }) })).json();
  assert.match(c.id, /^[0-9a-f]{32}$/); assert.ok(c.url.endsWith('/?share=' + c.id));
  const sh = { authorization: 'Share ' + c.id };
  const s = await call('/api/summary?from=2026-10-10&to=2026-10-10', {}, sh);
  assert.equal(s.status, 200); assert.equal((await s.json()).cur.revenue, 100);
  assert.equal((await call('/api/inventory', {}, sh)).status, 200);
  assert.equal((await call('/api/recent', {}, sh)).status, 401);                    // الطلبات بأسماء العملاء: توكن سلة فقط
  assert.equal((await call('/api/share', { method: 'POST', body: '{}' }, sh)).status, 401); // الرابط لا يُنشئ روابط
  assert.equal((await (await call('/api/share')).json()).shares.length, 1);
  assert.equal((await call('/api/summary?from=2026-10-10&to=2026-10-10', {}, { authorization: 'Share ' + '0'.repeat(32) })).status, 401);
  await call('/api/share?id=' + c.id, { method: 'DELETE' });
  assert.equal((await call('/api/summary?from=2026-10-10&to=2026-10-10', {}, sh)).status, 401);
  const c2 = await (await call('/api/share', { method: 'POST', body: '{}' })).json();
  env.TOKENS.m.set('share:' + c2.id, JSON.stringify({ merchant: '346539387', exp: Date.now() - 1 }));
  assert.equal((await call('/api/summary?from=2026-10-10&to=2026-10-10', {}, { authorization: 'Share ' + c2.id })).status, 401);
});

test('export.csv: share-gated aggregate CSV reports for Google Sheets', async () => {
  const env = mkEnv(); mockFetch(good);
  await seedDay(env, '2026-10-10', [{ t: 100 }]);
  const call = (path, init = {}, hdr = auth.headers) => worker.fetch(new Request('https://x.test' + path, { ...init, headers: hdr }), env);
  const c = await (await call('/api/share', { method: 'POST', body: JSON.stringify({ days: 365 }) })).json();
  const url = (r) => `/api/export.csv?share=${c.id}&report=${r}&from=2026-10-10&to=2026-10-10`;
  const d = await call(url('daily'), {}, {});
  assert.equal(d.status, 200); assert.match(d.headers.get('content-type'), /text\/csv/);
  const buf = new Uint8Array(await d.arrayBuffer()), t = new TextDecoder().decode(buf);
  assert.ok(t.includes('2026-10-10,1,100')); assert.deepEqual([...buf.slice(0, 3)], [0xef, 0xbb, 0xbf]);   // BOM لعرض العربية صحيحاً
  for (const r of ['summary', 'products', 'categories', 'cancelled']) assert.equal((await call(url(r), {}, {})).status, 200);
  assert.equal((await call('/api/export.csv?report=daily', {}, {})).status, 401);
  assert.equal((await call(`/api/export.csv?share=${'0'.repeat(32)}&report=daily`, {}, {})).status, 401);
  assert.equal((await call(url('nope'), {}, {})).status, 400);
});

test('export.csv orders: per-order date + total only, valid orders by default', async () => {
  const env = mkEnv();
  const ord = (id, d, total, slug) => ({ id, reference_id: id, total: { amount: total }, date: { date: d + ':00.000000' }, status: { slug }, draft: false, customer: { id: 1, full_name: 'سري' }, items: [] });
  mockFetch(good, { '/orders': () => ok([ord(1, '2026-10-10 09:05', 100.5, 'completed'), ord(2, '2026-10-10 08:00', 40, 'canceled'), ord(3, '2026-10-09 23:59', 7, 'completed')], { totalPages: 1 }) });
  const call = (path, init = {}, hdr = auth.headers) => worker.fetch(new Request('https://x.test' + path, { ...init, headers: hdr }), env);
  const c = await (await call('/api/share', { method: 'POST', body: '{}' })).json();
  const r = await call(`/api/export.csv?share=${c.id}&report=orders&from=2026-10-10&to=2026-10-10`, {}, {});
  assert.equal(r.status, 200);
  const t = await r.text();
  assert.ok(t.includes('2026-10-10 09:05,100.5')); assert.ok(!t.includes('40')); assert.ok(!t.includes('سري')); assert.ok(!t.includes('2026-10-09'));
  assert.equal((await call(`/api/export.csv?share=${c.id}&report=orders&period=year`, {}, {})).status, 400);
});

test('periodRange: monthN = N months ago', async () => {
  const { periodRange } = await import('../src/export.js');
  assert.deepEqual(periodRange('month1', '2026-10-21'), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(periodRange('month2', '2026-10-21'), { from: '2026-08-01', to: '2026-08-31' });
  assert.deepEqual(periodRange('month3', '2026-02-10'), { from: '2025-11-01', to: '2025-11-30' });
  assert.deepEqual(periodRange('lastmonth', '2026-01-05'), { from: '2025-12-01', to: '2025-12-31' });
});

test('export.csv orders: refuses (400) instead of silently truncating huge ranges', async () => {
  const env = mkEnv();
  mockFetch(good, { '/orders': () => ok([], { totalPages: 301 }) });
  const call = (path, hdr = auth.headers) => worker.fetch(new Request('https://x.test' + path, { headers: hdr }), env);
  const c = await (await worker.fetch(new Request('https://x.test/api/share', { method: 'POST', body: '{}', headers: auth.headers }), env)).json();
  const r = await call(`/api/export.csv?share=${c.id}&report=orders&from=2026-10-01&to=2026-10-20`, {});
  assert.equal(r.status, 400); assert.match(await r.text(), /too many orders/);
});

test('export.csv unavailable: items of orders canceled with an "out of stock" history note', async () => {
  const env = mkEnv();
  const ord = (id, d, status, items) => ({ id, reference_id: 900 + id, total: { amount: 50 }, date: { date: d + ':00.000000' }, status: { slug: status }, draft: false, items });
  const hist = { 1: 'عدم توفر المنتج', 2: 'من قبل العميل', 3: '' };
  mockFetch(good, {
    '/orders/': (u) => { const id = Number(/orders\/(\d+)\/histories/.exec(u)[1]); return ok([{ status: 'ملغي', customized: { slug: 'canceled' }, note: hist[id] }, { status: 'ملغي', customized: { slug: 'canceled' }, note: 'تم إرجاع المنتجات إلى المخزون' }], { totalPages: 1 }); },
    '/orders': () => ok([ord(1, '2026-10-10 09:05', 'canceled', [{ name: 'حليب', quantity: 2 }, { name: 'حفاض', quantity: 1 }]), ord(2, '2026-10-10 10:00', 'canceled', [{ name: 'X', quantity: 1 }]), ord(3, '2026-10-11 10:00', 'completed', [{ name: 'Y', quantity: 1 }])], { totalPages: 1 })
  });
  const call = (path, init = {}, hdr = auth.headers) => worker.fetch(new Request('https://x.test' + path, { ...init, headers: hdr }), env);
  const c = await (await call('/api/share', { method: 'POST', body: '{}' })).json();
  const r = await call(`/api/export.csv?share=${c.id}&report=unavailable&from=2026-10-10&to=2026-10-11`, {}, {});
  assert.equal(r.status, 200);
  const t = await r.text();
  assert.ok(t.includes('2026-10-10,901,حليب,2,50')); assert.ok(t.includes('حفاض'));
  assert.ok(!t.includes('X') && !t.includes('Y'));
  const lim = await (await call(`/api/export.csv?share=${c.id}&report=unavailable&from=2026-10-10&to=2026-10-11&limit=1`, {}, {})).text();
  assert.equal(lim.trim().split('\n').length, 2);
  assert.equal((await call(`/api/export.csv?share=${c.id}&report=unavailable&period=year`, {}, {})).status, 400);
});

test('months: average over complete months only; endpoint requires auth and returns months', async () => {
  const { monthsReport } = await import('../src/worker.js');
  const row = (m, days, revenue, orders) => ({ m, days, revenue, orders, units: orders * 2, canceled: 5, canceledValue: 50 });
  const j = monthsReport([row('2026-07', 1, 999, 1), row('2026-08', 31, 3100, 31), row('2026-09', 30, 6000, 30), row('2026-10', 2, 50, 1)], '2026-10-02');
  const by = Object.fromEntries(j.months.map((x) => [x.m, x]));
  assert.equal(by['2026-07'].complete, false); assert.equal(by['2026-10'].complete, false); assert.equal(by['2026-09'].complete, true);
  assert.equal(j.avg.months, 2); assert.equal(j.avg.revenue, 4550); assert.equal(j.avg.orders, 31); assert.equal(j.avg.best.m, '2026-09');
  assert.equal(j.avg.perDay, Math.round(9100 / 61 * 100) / 100); assert.equal(by['2026-08'].aov, 100);
  const env = mkEnv(); mockFetch(good);
  await seedDay(env, riyadhDay(Date.now()), [{ t: 100 }]);
  const r = await get(env, '/api/months?n=3'); assert.equal(r.status, 200);
  assert.ok(Array.isArray((await r.json()).months));
  assert.equal((await worker.fetch(new Request('https://x.test/api/months'), env)).status, 401);
});

test('search-gaps: key stays server-side; friendly errors; Salla token or share (first 50 rows); cached', async () => {
  const sample = { generated_at: 1793500000000, totals: { searches: 1840, zero_searches: 212, missing_phrases: 31, recovered_phrases: 18 },
    missing: [{ q: 'dermedic', total: 7, zero: 7, results: 0, first: 1, last: 2, evil: 'x' }], codes: [], recovered: [{ q: 'a', total: 3, zero: 1, results: 4, first: 1, last: 2 }], top: [] };
  let seen = null, status = 200;
  const mk = (extra = {}) => ({ ...mkEnv(), REPORT_KEY: 'sekret-123', SEARCH: { fetch: async (u, init) => { seen = { u, key: init.headers['x-report-key'] }; return new Response(JSON.stringify(sample), { status }); } }, ...extra });
  mockFetch(good);
  let env = mk();
  const r = await get(env, '/api/search-gaps'); assert.equal(r.status, 200);
  const body = await r.text(); assert.ok(!body.includes('sekret-123')); const j = JSON.parse(body);
  assert.equal(seen.key, 'sekret-123'); assert.equal(j.totals.zero_searches, 212); assert.equal(j.missing[0].q, 'dermedic'); assert.equal(j.missing[0].evil, undefined);
  seen = null; await get(env, '/api/search-gaps'); assert.equal(seen, null);                 // من الذاكرة المؤقتة
  __clearMemo(); status = 401; assert.equal((await (await get(env, '/api/search-gaps')).json()).error, 'bad_key');
  __clearMemo(); status = 503; assert.equal((await (await get(env, '/api/search-gaps')).json()).error, 'disabled');
  __clearMemo(); status = 500; assert.equal((await (await get(env, '/api/search-gaps')).json()).error, 'unreachable');
  __clearMemo(); status = 200; assert.equal((await (await get(env, '/api/search-gaps')).json()).error, undefined);   // الخطأ لم يُخزَّن
  __clearMemo(); env = mk({ REPORT_KEY: undefined }); assert.equal((await (await get(env, '/api/search-gaps')).json()).error, 'not_configured');
  env = mk(); assert.equal((await worker.fetch(new Request('https://x.test/api/search-gaps'), env)).status, 401);
  const c = await (await worker.fetch(new Request('https://x.test/api/share', { method: 'POST', body: '{}', ...auth }), env)).json();
  sample.missing = Array.from({ length: 80 }, (_, i) => ({ q: 'q' + i, total: 1, zero: 1, results: 0, first: 1, last: 2 })); __clearMemo();
  const sh = await worker.fetch(new Request('https://x.test/api/search-gaps', { headers: { authorization: 'Share ' + c.id } }), env);
  assert.equal(sh.status, 200); const sj = await sh.json(); assert.equal(sj.missing.length, 50); assert.ok(!JSON.stringify(sj).includes('sekret-123'));
  assert.equal((await (await get(env, '/api/search-gaps')).json()).missing.length, 80);   // توكن سلة: القائمة كاملة (حتى 500)
  assert.equal((await worker.fetch(new Request('https://x.test/api/search-gaps', { headers: { authorization: 'Share ' + '0'.repeat(32) } }), env)).status, 401);
});

test('care-orders: tagged orders only (tag filter param), valid vs canceled, share of all orders; refuses when tag filter is ignored', async () => {
  const env = mkEnv();
  const ord = (id, d, status, total, pm = 'cod') => ({ id, reference_id: 900 + id, total: { amount: total }, date: { date: d + ':00.000000' }, status: { slug: status, name: status }, draft: false, payment_method: pm, items: [] });
  const seen = [];
  const ignoreFilter = { on: false };
  mockFetch(good, { '/orders/tags': () => ok([{ id: 52805995, name: 'Customer Care Team' }, { id: 777, name: 'customer Care Team' }, { id: 5, name: 'Other' }]), '/orders': (u) => {
    const q = new URL(u).searchParams; seen.push(q.get('tags[0]'));
    if (q.get('source[0]') === 'dashboard' && !ignoreFilter.on) return ok([ord(1, '2026-10-10 09:00', 'completed', 100), ord(7, '2026-10-10 15:00', 'completed', 30)], { total: 2, totalPages: 1 });   // أُنشئت من لوحة التحكم (7 بلا وسم)
    if (q.get('tags[0]') === '777') return ok([ord(1, '2026-10-10 09:00', 'completed', 100), ord(6, '2026-10-11 12:00', 'completed', 50)], { total: 2, totalPages: 1 });   // الوسم الثاني: الطلب 1 مكرر
    if (q.get('tags[0]') && !ignoreFilter.on) return ok([ord(1, '2026-10-10 09:00', 'completed', 100), ord(2, '2026-10-10 10:00', 'canceled', 40), ord(3, '2026-10-11 10:00', 'under_review', 60, 'mada'), ord(4, '2026-10-11 11:00', 'payment_pending', 5), ord(5, '2026-10-12 11:00', 'completed', 999)], { total: 5, totalPages: 1 });
    return ok([ord(9, '2026-10-10 09:00', 'completed', 1)], { total: 100, totalPages: 4 });
  } });
  await seedDay(env, '2026-10-10', [{ t: 100 }, { t: 100 }, { t: 30 }]); await seedDay(env, '2026-10-11', [{ t: 100 }, { t: 100 }]);
  const j = await (await get(env, '/api/care-orders?from=2026-10-10&to=2026-10-11')).json();
  assert.ok(seen.includes('52805995') && seen.includes('777') && !seen.includes('5'));                                   // وسم خدمة العملاء مرسل لسلة
  assert.equal(j.valid, 4); assert.equal(j.revenue, 240); assert.equal(j.canceled, 1); assert.equal(j.unpaid, 1); assert.equal(j.aov, 60); assert.equal(j.taggedOrders, 5); assert.equal(j.untaggedOrders, 1); assert.deepEqual(j.tags.sort(), ['52805995', '777']);
  assert.deepEqual(j.series, [['2026-10-10', 2, 130], ['2026-10-11', 2, 110]]);   // 2026-10-12 خارج الفترة
  assert.equal(j.orders, 6); assert.deepEqual(j.statusNames.map((x) => x[1]), [3, 1, 1, 1]); assert.equal(j.rows, undefined);
  const jl = await (await get(env, '/api/care-orders?from=2026-10-10&to=2026-10-11&list=1')).json();
  assert.equal(jl.rows.length, 6); assert.equal(jl.rows.filter((r) => r[5] === 'لا').length, 1); assert.deepEqual(jl.rows[0].slice(1, 4), [901, 'completed', 100]);
  assert.equal(j.all.orders, 5); assert.equal(j.shareOrders, 80);
  assert.equal(j.pay.find((x) => x.k === 'mada').orders, 1);
  assert.equal((await worker.fetch(new Request('https://x.test/api/care-orders?from=2026-10-10&to=2026-10-11'), env)).status, 401);
  const c = await (await worker.fetch(new Request('https://x.test/api/share', { method: 'POST', body: '{}', ...auth }), env)).json();
  assert.equal((await worker.fetch(new Request('https://x.test/api/care-orders?from=2026-10-10&to=2026-10-11', { headers: { authorization: 'Share ' + c.id } }), env)).status, 200);
  __clearMemo(); ignoreFilter.on = true;
  assert.equal((await (await get(env, '/api/care-orders?from=2026-10-10&to=2026-10-11')).json()).error, 'tag_filter_ignored');
});

test('chat-stats: numbers only from /report/chat via binding; key server-side; errors friendly; share allowed', async () => {
  const sample = { generated_at: 1793500000000, totals: { msgs: 120, carts: 9, handoffs: 4, ratings: { up: 5, down: 1 }, tokens: 52000, note: 'نص عميل سري' },
    rates_percent: { cart_rate: 7.5, handoff_rate: 3.3 }, daily: [{ day: '2026-11-01', msgs: 10, carts: 1, text: 'سري' }, { day: 'bad', msgs: 1 }, { date: '2026-11-02', msgs: 5 }], messages: [{ text: 'محادثة سرية' }] };
  let seen = null, status = 200;
  const env = { ...mkEnv(), REPORT_KEY: 'sekret-123', SEARCH: { fetch: async (u, init) => { seen = { u, key: init.headers['x-report-key'] }; return new Response(JSON.stringify(sample), { status }); } } };
  mockFetch(good);
  const r = await get(env, '/api/chat-stats'); assert.equal(r.status, 200);
  const body = await r.text(); assert.ok(!body.includes('sekret-123') && !body.includes('سري') && !body.includes('محادثة'));
  const j = JSON.parse(body);
  assert.match(seen.u, /\/report\/chat$/); assert.equal(seen.key, 'sekret-123');
  assert.equal(j.totals.msgs, 120); assert.equal(j.totals.ratings_up, 5); assert.equal(j.totals.note, undefined); assert.equal(j.rates.cart_rate, 7.5);
  assert.deepEqual(j.daily.map((x) => x.day), ['2026-11-01', '2026-11-02']); assert.equal(j.daily[0].text, undefined);
  __clearMemo(); status = 401; assert.equal((await (await get(env, '/api/chat-stats')).json()).error, 'bad_key');
  __clearMemo(); status = 503; assert.equal((await (await get(env, '/api/chat-stats')).json()).error, 'disabled');
  __clearMemo(); status = 404; assert.equal((await (await get(env, '/api/chat-stats')).json()).error, 'not_ready');
  __clearMemo(); status = 500; assert.equal((await (await get(env, '/api/chat-stats')).json()).error, 'unreachable');
  __clearMemo(); status = 200; assert.equal((await (await get({ ...env, REPORT_KEY: undefined }, '/api/chat-stats')).json()).error, 'not_configured');
  assert.equal((await worker.fetch(new Request('https://x.test/api/chat-stats'), env)).status, 401);
  const c = await (await worker.fetch(new Request('https://x.test/api/share', { method: 'POST', body: '{}', ...auth }), env)).json();
  assert.equal((await worker.fetch(new Request('https://x.test/api/chat-stats', { headers: { authorization: 'Share ' + c.id } }), env)).status, 200);
});

test('competitors API: add/check, our price (+VAT) vs competitor, ignore/delete, auth, cron checks only what is due', async () => {
  const { compCron } = await import('../src/worker.js');
  const env = mkEnv();
  const page = (price) => `<script type="application/ld+json">{"@type":"Product","name":"P","offers":{"price":${price},"availability":"https://schema.org/InStock"}}</script>`;
  const comp = { 'https://a-pharm.com/p1': 50, 'https://b-pharm.com/p1': 200 };
  const realFetch = mockFetch(good), prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => { const u = String(url); if (comp[u]) return new Response(page(comp[u])); return prev(url, init); };
  await ensureSchema(env.DB);
  await env.DB.prepare('INSERT INTO catalog (merchant, name, price, img, cat, taxable) VALUES (?, ?, ?, ?, ?, ?)').bind('346539387', 'Milk', 100, '', '', 1).run();
  const post = (path, body, hdr = auth.headers) => worker.fetch(new Request('https://x.test/api/competitors' + path, { method: 'POST', body: JSON.stringify(body), headers: hdr }), env);
  const bad = await (await post('', { lines: [{ product: 'Milk', competitor: 'X', url: 'http://insecure.com/p' }, { product: '', competitor: 'X', url: 'https://a-pharm.com/p1' }] })).json();
  assert.equal(bad.added, 0); assert.equal(bad.rejected.length, 2);
  const r = await (await post('', { lines: [{ product: 'Milk', competitor: 'A-Pharm', url: 'https://a-pharm.com/p1' }] })).json();   // واحد: يُفحص فوراً
  assert.equal(r.added, 1); assert.equal(r.results[0].price, 50);
  const pre = await (await post('', { lines: [{ product: 'Milk', competitor: 'Suggested', url: 'https://a-pharm.com/sug', price: 77.5, avail: 1, title: 'ت' }], check: false })).json();   // اقتراح معتمد بسعر جاهز
  assert.equal(pre.added, 1); let l0 = await (await get(env, '/api/competitors')).json(); const sg = l0.items.find((x) => x.competitor === 'Suggested'); assert.equal(sg.price, 77.5); assert.ok(sg.checked > 0); assert.equal(sg.err, '');
  await worker.fetch(new Request('https://x.test/api/competitors?id=' + sg.id, { method: 'DELETE', ...auth }), env);
  const list = await (await get(env, '/api/competitors')).json();
  assert.equal(list.items.length, 1); assert.equal(list.items[0].price, 50); assert.equal(list.items[0].ourPrice, 115);   // 100 + 15% ضريبة
  assert.equal(list.items[0].diffPct, 130); assert.equal(list.items[0].avail, 1);
  // عدة روابط: لا فحص فوري، والجدول المجدول يفحصها
  const many = await (await post('', { lines: Array.from({ length: 6 }, (_, i) => ({ product: 'Milk', competitor: 'B' + i, url: 'https://b-pharm.com/p1' })) })).json();
  assert.equal(many.added, 6); assert.deepEqual(many.results, []);
  const n = await compCron(env, Date.now()); assert.equal(n, 6);   // الأول فُحص اليوم فلا يدخل
  const after = (await (await get(env, '/api/competitors')).json()).items.filter((x) => x.competitor.startsWith('B'));
  assert.ok(after.every((x) => x.price === 200 && !x.err));
  assert.equal(await compCron(env, Date.now()), 0);                 // لا شيء مستحق بعد الفحص
  const id = after[0].id;
  await post('/ignore', { id, ignored: true }); assert.equal((await (await get(env, '/api/competitors')).json()).items.find((x) => x.id === id).ignored, 1);
  const chk = await (await post('/check', { id: list.items[0].id })).json(); assert.equal(chk.price, 50);
  assert.equal((await worker.fetch(new Request('https://x.test/api/competitors?id=' + id, { method: 'DELETE', ...auth }), env)).status, 200);
  assert.equal((await (await get(env, '/api/competitors')).json()).items.some((x) => x.id === id), false);
  assert.equal((await worker.fetch(new Request('https://x.test/api/competitors'), env)).status, 401);
  const c = await (await worker.fetch(new Request('https://x.test/api/share', { method: 'POST', body: '{}', ...auth }), env)).json();
  const sh = { authorization: 'Share ' + c.id };
  const shGet = await worker.fetch(new Request('https://x.test/api/competitors', { headers: sh }), env);   // الإدارة (رابط المشاركة) تقرأ فقط
  assert.equal(shGet.status, 200); assert.ok((await shGet.json()).items.length >= 1);
  for (const [m, path, body] of [['POST', '', { lines: [{ product: 'Milk', competitor: 'Z', url: 'https://z.com/p' }] }], ['POST', '/check', { id: 1 }], ['POST', '/suggest', { product: 'Milk' }], ['POST', '/verify', { id: 1, on: true }], ['POST', '/ignore', { id: 1, ignored: true }], ['DELETE', '?id=1', null]]) {
    assert.equal((await worker.fetch(new Request('https://x.test/api/competitors' + path, { method: m, body: body ? JSON.stringify(body) : undefined, headers: sh }), env)).status, 401, m + path);   // التعديل بتوكن سلة فقط
  }
  assert.equal((await worker.fetch(new Request('https://x.test/api/competitors', { headers: { authorization: 'Share ' + '0'.repeat(32) } }), env)).status, 401);
  globalThis.fetch = prev;
});

test('competitors: suggest uses our barcode (sku) + English slug; weekly job adds sure matches (barcode = verified) for top sellers, 2 products per tick, once a week', async () => {
  const { compCron } = await import('../src/worker.js');
  const env = mkEnv();
  const code = '6281008298482';
  const page = `<script type="application/ld+json">{"@type":"Product","name":"بيبي جوي مقاس (5) صندوق جامبو 80 حفاضة","sku":"${code}","offers":{"price":95.72,"availability":"https://schema.org/InStock"}}</script>`;
  const prev = globalThis.fetch; let salla = 0;
  mockFetch(good, { '/products': (u) => { salla++; return ok([{ name: 'بيبي جوي مقاس (5) صندوق جامبو 80 حفاضة', sku: code, mpn: '1012406569', metadata: { url: 'baby-joy-size-5-box-jumbo-80-diaper' } }]); } });
  const base = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://sidalih.com/search')) return new Response(decodeURIComponent(u).includes(code) ? '<a href="/products/baby-joy-5"></a>' : '');
    if (u === 'https://sidalih.com/products/baby-joy-5') return new Response(`<html>${page}</html>`);
    if (u.startsWith('https://api.test') || u.startsWith('https://i.test')) return base(url, init);
    if (u.startsWith('https://')) return new Response('', { status: 404 });   // بقية مواقع المنافسين
    return base(url, init);
  };
  await seedDay(env, riyadhDay(Date.now() - 864e5), [{ t: 100, items: [{ name: 'بيبي جوي مقاس (5) صندوق جامبو 80 حفاضة', quantity: 3 }] }, { t: 50, items: [{ name: 'منتج آخر', quantity: 1 }] }, { t: 50, items: [{ name: 'ثالث', quantity: 1 }] }]);
  const post = (path, body) => worker.fetch(new Request('https://x.test/api/competitors' + path, { method: 'POST', body: JSON.stringify(body), headers: auth.headers }), env);
  const sg = await (await post('/suggest', { product: 'بيبي جوي مقاس (5) صندوق جامبو 80 حفاضة' })).json();
  assert.equal(sg.barcode, code); assert.equal(sg.suggestions[0].competitor, 'صيدلية كوم'); assert.equal(sg.suggestions[0].matchby, 'barcode'); assert.equal(sg.suggestions[0].score, 1);
  await compCron(env, Date.now());                                    // أول تشغيل: يبدأ المهمة الأسبوعية ويعالج دفعة (كل المنتجات الثلاثة)
  let items = (await (await get(env, '/api/competitors')).json()).items;
  const it = items.find((x) => x.competitor === 'صيدلية كوم'); assert.ok(it); assert.equal(it.matchby, 'barcode'); assert.equal(it.verified, 1); assert.equal(it.price, 95.72); assert.equal(it.code, code);
  const { getMeta } = await import('../src/db.js');
  const job = await getMeta(env.DB, '346539387', 'comp_job', null); assert.equal(job.idx, 3); assert.equal(job.queue.length, 3); assert.equal(job.done, true); assert.equal(job.mode, 'weekly'); assert.equal(job.added, 1);
  const before = salla; await compCron(env, Date.now()); assert.equal(salla, before);       // لا بحث جديد قبل مرور أسبوع
  // مهمة يدوية من المتصفح: تُبدأ، وتُدفع بدفعات، وتستمر على الخادم
  const st0 = await (await post('/job', { n: 2 })).json(); assert.equal(st0.running, true); assert.equal(st0.total, 2); assert.equal(st0.idx, 0);
  assert.equal((await (await post('/job', { n: 50 })).json()).total, 2);                      // مهمة جارية: لا تُستبدل
  const st1 = await (await post('/job/step', {})).json(); assert.equal(st1.running, false); assert.equal(st1.idx, 2);
  const gj = await (await get(env, '/api/competitors/job')).json(); assert.equal(gj.running, false); assert.equal(gj.total, 2);
  assert.equal((await worker.fetch(new Request('https://x.test/api/competitors/job', { headers: { authorization: 'Share ' + '0'.repeat(32) } }), env)).status, 401);
  await post('/verify', { id: it.id, on: false }); items = (await (await get(env, '/api/competitors')).json()).items; assert.equal(items.find((x) => x.id === it.id).verified, 0);
  globalThis.fetch = prev;
});

test('competitors /clean: unverified name matches whose title fits another of our products better are ignored; barcode/verified ones stay', async () => {
  const env = mkEnv(); mockFetch(good); await ensureSchema(env.DB);
  const cat = async (name) => env.DB.prepare('INSERT INTO catalog (merchant, name, price, img, cat, taxable) VALUES (?, ?, ?, ?, ?, ?)').bind('346539387', name, 100, '', '', 1).run();
  await cat('نان حليب أطفال رقم (1) 800 جم'); await cat('نان ديو حليب أطفال رقم (1) 800 جم');
  const ins = (p, mb, ver) => env.DB.prepare("INSERT INTO comp_item (merchant, product, competitor, url, price, title, matchby, score, verified) VALUES ('346539387', ?, ?, 'https://n/p', 10, 'نان ديو 1 800 جم', ?, 0.79, ?)").bind(p, 'N' + mb + ver, mb, ver).run();
  await ins('نان حليب أطفال رقم (1) 800 جم', 'name', 0);      // خاطئ
  await ins('نان حليب أطفال رقم (1) 800 جم', 'name', 1);      // خاطئ لكنه متحقق منه يدوياً: لا يُمس
  await ins('نان حليب أطفال رقم (1) 800 جم', 'barcode', 0);   // باركود: لا يُمس
  await ins('نان ديو حليب أطفال رقم (1) 800 جم', 'name', 0);  // صحيح
  const r = await (await worker.fetch(new Request('https://x.test/api/competitors/clean', { method: 'POST', body: '{}', ...auth }), env)).json();
  assert.equal(r.ignored, 1);
  const items = (await (await get(env, '/api/competitors')).json()).items;
  assert.equal(items.filter((x) => x.ignored).length, 1); assert.ok(items.find((x) => x.ignored).product.startsWith('نان حليب') && items.find((x) => x.ignored).verified === 0 && items.find((x) => x.ignored).matchby === 'name');
});
