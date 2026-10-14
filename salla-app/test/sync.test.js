import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1, makeKV, fakeSalla } from './helpers.js';
import { syncMerchant, addDays, clearPriceCache } from '../src/sync.js';
import { ensureSchema, rangeRows, coverage, getMeta, readInventory, campaignStats, readCatalog } from '../src/db.js';

const NOW = Date.parse('2026-10-12T09:00:00Z');   // 12:00 الرياض
const TODAY = '2026-10-12';
const setup = (over = {}) => ({ DB: makeD1(), TOKENS: makeKV(), BACKFILL_DAYS: '60', SYNC_BUDGET: '40', CATALOG_SYNC: 'off', ...over });

test('first run loads inventory first, then orders; prices come from inventory', async () => {
  clearPriceCache();
  const env = setup(); const calls = [];
  const get = fakeSalla({ perDay: 4, calls });
  let r = await syncMerchant(env, 'm1', { get }, NOW);
  assert.deepEqual(r.log.slice(0, 3), ['inventory', 'probe:exact', 'recent']);   // المخزون ثم الأحدث، والأسعار جاهزة في نفس التشغيل
  assert.equal((await readInventory(env.DB, 'm1')).length, 2);
  const rows = await rangeRows(env.DB, 'm1', addDays(TODAY, -1), TODAY);
  assert.equal(rows.length, 2);
  const d = rows[1];
  assert.deepEqual([d.orders, d.valid, d.completed, d.canceled, d.revenue], [4, 3, 3, 1, 300]);
  assert.equal(d.prod.Dress[0], 3);
  assert.equal(d.prod.Dress[1], 120);          // 3 × سعر الكتالوج 40، لا تقدير الطلب
  assert.equal(d.hours[10], 3);
  assert.ok(r.used <= 40);
});

test('backfill walks back day by day over runs, stays within budget, finishes at the floor', async () => {
  clearPriceCache();
  const env = setup({ BACKFILL_DAYS: '45', SYNC_BUDGET: '20' });
  const get = fakeSalla({ perDay: 35 });       // يومان = صفحتان تقريباً لكل يوم
  let t = NOW, done = false;
  for (let i = 0; i < 200 && !done; i++, t += 60000) {
    const r = await syncMerchant(env, 'm1', { get }, t);
    assert.ok(r.skipped || r.used <= 20, `used ${r.used}`);
    done = !!r.backfillDone;
  }
  assert.ok(done, 'backfill should finish');
  const cov = await coverage(env.DB, 'm1');
  assert.equal(cov.oldest, addDays(TODAY, -45));
  assert.equal(cov.newest, TODAY);
  const all = await rangeRows(env.DB, 'm1', cov.oldest, TODAY);
  assert.equal(all.length, 46);                 // لا ثغرات
  assert.ok(all.every((d) => d.orders === 35));
});

test('works whether from_date/to_date are inclusive or exclusive', async () => {
  for (const inclusive of [true, false]) {
    clearPriceCache();
    const env = setup({ BACKFILL_DAYS: '5' });
    const get = fakeSalla({ perDay: 3, inclusive });
    for (let i = 0; i < 12; i++) await syncMerchant(env, 'm1', { get }, NOW + i * 60000);
    const rows = await rangeRows(env.DB, 'm1', addDays(TODAY, -5), TODAY);
    assert.ok(rows.length >= 6 && rows.every((d) => d.orders === 3), `inclusive=${inclusive}: ${rows.map((d) => d.orders)}`);
  }
});

test('over-budget range is not written, and chunk size adapts', async () => {
  clearPriceCache();
  const env = setup({ BACKFILL_DAYS: '10', SYNC_BUDGET: '45' });
  const get = fakeSalla({ perDay: 200 });      // ~7 صفحات لليوم: الدفعة الأولى لا تتسع
  const r1 = await syncMerchant(env, 'm1', { get }, NOW);
  assert.ok(r1.used <= 45);
  let st = await getMeta(env.DB, 'm1', 'state', {});
  assert.ok(st.ppd > 5, 'ppd should grow after a failed chunk');
  const rows = await rangeRows(env.DB, 'm1', addDays(TODAY, -10), addDays(TODAY, -2));
  assert.equal(rows.length, 0);                // لا ملخصات ناقصة
  for (let i = 1; i < 8; i++) await syncMerchant(env, 'm1', { get }, NOW + i * 60000);   // يتكيّف ثم ينجح
  assert.ok((await rangeRows(env.DB, 'm1', addDays(TODAY, -10), addDays(TODAY, -2))).length > 0);
});

test('a locked merchant is skipped', async () => {
  const env = setup(); await ensureSchema(env.DB);
  const get = fakeSalla();
  await syncMerchant(env, 'm1', { get }, NOW);
  const { setMeta } = await import('../src/db.js');
  await setMeta(env.DB, 'm1', 'state', { lockUntil: NOW + 30000 });
  assert.deepEqual(await syncMerchant(env, 'm1', { get }, NOW + 1000), { skipped: 'locked' });
});

test('schema bump restarts the backfill once', async () => {
  clearPriceCache();
  const env = setup({ BACKFILL_DAYS: '5' });
  const get = fakeSalla({ perDay: 2 });
  for (let i = 0; i < 12; i++) await syncMerchant(env, 'm1', { get }, NOW + i * 60000);
  let st = await getMeta(env.DB, 'm1', 'state', {});
  assert.equal(st.backfillDone, true);
  const { setMeta } = await import('../src/db.js');
  await setMeta(env.DB, 'm1', 'state', { ...st, schema: 1 });          // محاكاة صفوف بالشكل القديم
  await syncMerchant(env, 'm1', { get }, NOW + 13 * 60000);
  st = await getMeta(env.DB, 'm1', 'state', {});
  assert.equal(st.schema, 5);
  assert.ok(st.backfillDone === false || st.backfillNext !== null || st.resyncNext, 'backfill restarted');
});

test('campaign attribution: order details fetched once per order, stats by source and campaign', async () => {
  clearPriceCache();
  const env = setup({ CAMPAIGN_DAYS: '3', BACKFILL_DAYS: '3', SYNC_BUDGET: '40' });
  const calls = [];
  const get = fakeSalla({ perDay: 4, calls });
  for (let i = 0; i < 25; i++) await syncMerchant(env, 'm1', { get }, NOW + i * 60000);
  const detailCalls = calls.filter(([p]) => /^\/orders\/\d+$/.test(p)).map(([p]) => p);
  assert.equal(new Set(detailCalls).size, detailCalls.length, 'no order detail fetched twice');
  const st = await campaignStats(env.DB, 'm1', addDays(TODAY, -3), TODAY);
  assert.equal(st.attributed, st.total, 'all valid orders attributed');
  assert.ok(st.total > 0);
  const k = Object.fromEntries(st.sources.map((x) => [x.k, x]));
  assert.ok(k.instagram && k['']);
  assert.equal(st.campaigns[0].camp, '1202');
  assert.equal(st.campaigns[0].src, 'instagram');
  assert.equal(st.attributed, k.instagram.orders + k[''].orders);
});

test('catalog prices (inventory off): orders are priced by product name, sale price wins; backfill waits for the catalog', async () => {
  clearPriceCache();
  const env = setup({ CATALOG_SYNC: 'on', INVENTORY_SYNC: 'off', BACKFILL_DAYS: '3' });
  const get = fakeSalla({ perDay: 4 });
  const r = await syncMerchant(env, 'm1', { get }, NOW);
  assert.equal(r.log[0], 'catalog');
  assert.deepEqual((await readCatalog(env.DB, 'm1')).map((x) => [x.name, x.price, x.cat]).sort(), [['dress', 70, 'فساتين'], ['shoe', 60, 'أحذية']]);
  const rows = await rangeRows(env.DB, 'm1', TODAY, TODAY);
  assert.equal(rows[0].prod.Dress[1], 210);   // 3 × سعر العرض 70، لا تقدير الإجمالي
  const st = await getMeta(env.DB, 'm1', 'state', {});
  assert.equal(st.catDoneOnce, true);
});

test('catalog failure does not stall orders', async () => {
  clearPriceCache();
  const env = setup({ CATALOG_SYNC: 'on', INVENTORY_SYNC: 'off' });
  const base = fakeSalla({ perDay: 2 });
  const get = async (path, p) => { if (path === '/products') throw new Error('salla 422 /products bad'); return base(path, p); };
  const r = await syncMerchant(env, 'm1', { get }, NOW);
  assert.ok(r.log.includes('recent'));
  assert.match((await getMeta(env.DB, 'm1', 'state', {})).catError, /422/);
});

test('customers: distinct buyers, new vs returning, from orders', async () => {
  clearPriceCache();
  const env = setup({ BACKFILL_DAYS: '3' });
  const base = fakeSalla({ perDay: 4 });          // العملاء 0..3 كل يوم؛ 0 ملغي دائماً
  await syncMerchant(env, 'm1', { get: base }, NOW);
  const { customerStats, customerTotal } = await import('../src/db.js');
  const s = await customerStats(env.DB, 'm1', addDays(TODAY, -1), TODAY);
  assert.equal(s.active, 3);                      // ١..٣ (٠ ملغي لا يُحسب)
  assert.equal(await customerTotal(env.DB, 'm1'), 3);
  assert.equal(s.fresh + s.returning, s.active);
});

test('gaps are detected and healed (e.g. an abandoned resync leaves missing days)', async () => {
  clearPriceCache();
  const env = setup({ BACKFILL_DAYS: '20', SYNC_BUDGET: '40' });
  const get = fakeSalla({ perDay: 5 });
  let t = NOW;
  for (let i = 0; i < 60; i++, t += 60000) if ((await syncMerchant(env, 'm1', { get }, t)).backfillDone) break;
  const all = async () => (await rangeRows(env.DB, 'm1', addDays(TODAY, -20), TODAY)).length;
  assert.equal(await all(), 21);
  await env.DB.prepare('DELETE FROM day_agg WHERE merchant = ? AND day BETWEEN ? AND ?').bind('m1', addDays(TODAY, -14), addDays(TODAY, -9)).run();
  assert.equal(await all(), 15);
  const { setMeta } = await import('../src/db.js');
  const st = await getMeta(env.DB, 'm1', 'state', {});
  await setMeta(env.DB, 'm1', 'state', { ...st, lastGapHour: -1 });
  for (let i = 0; i < 30; i++, t += 60000) await syncMerchant(env, 'm1', { get }, t);
  assert.equal(await all(), 21);
});

test('date semantics probe: exact range when the API filters precisely, expanded window otherwise', async () => {
  for (const [inclusive, mode] of [[true, 'exact'], [false, 'expand']]) {
    clearPriceCache();
    const env = setup({ INVENTORY_SYNC: 'off' });
    const get = fakeSalla({ perDay: 4, inclusive });
    await syncMerchant(env, 'm1', { get }, NOW);
    assert.equal((await getMeta(env.DB, 'm1', 'state', {})).dateMode, mode);
  }
});

test('heavy single day (many pages) completes in exact mode within the budget', async () => {
  clearPriceCache();
  const env = setup({ INVENTORY_SYNC: 'off', BACKFILL_DAYS: '6', SYNC_BUDGET: '40' });
  const get = fakeSalla({ perDay: (d) => (d <= addDays(TODAY, -3) && d >= addDays(TODAY, -5) ? 300 : 25) });   // أيام تخفيضات ثقيلة (10 صفحات) بين أيام هادئة؛ موسّعةً 3 أيام = 30 صفحة لا تتسع
  let t = NOW, done = false;
  for (let i = 0; i < 80 && !done; i++, t += 60000) done = !!(await syncMerchant(env, 'm1', { get }, t)).backfillDone;
  assert.ok(done, 'backfill finishes despite heavy days');
  assert.equal((await rangeRows(env.DB, 'm1', addDays(TODAY, -6), TODAY)).length, 7);
});

test('catalog refresh (e.g. new category data) is not starved by a running archive backfill', async () => {
  clearPriceCache();
  const env = setup({ CATALOG_SYNC: 'on', INVENTORY_SYNC: 'off', BACKFILL_DAYS: '40' });
  const get = fakeSalla({ perDay: 40 });
  let t = NOW;
  for (let i = 0; i < 6; i++, t += 60000) await syncMerchant(env, 'm1', { get }, t);
  const { setMeta, readCatalog: rc } = await import('../src/db.js');
  await env.DB.prepare('DELETE FROM catalog WHERE merchant = ?').bind('m1').run();
  const st = await getMeta(env.DB, 'm1', 'state', {});
  assert.equal(st.backfillDone, false);                           // الأرشيف ما زال يعمل
  await setMeta(env.DB, 'm1', 'state', { ...st, catVer: 1 });      // نسخة قديمة => تحديث للكتالوج مطلوب
  for (let i = 0; i < 3; i++, t += 60000) await syncMerchant(env, 'm1', { get }, t);
  assert.ok((await rc(env.DB, 'm1')).length >= 2, 'catalog refreshed while backfill is still running');
});

test('customers: first purchase day tracked across days (new vs returning) and migration from cust_day', async () => {
  const env = setup(); await ensureSchema(env.DB);
  const { upsertCustDays, customerStats, customerTotal, initCustFirst } = await import('../src/db.js');
  await upsertCustDays(env.DB, 'm1', [['a', '2026-10-05'], ['b', '2026-10-05'], ['a', '2026-10-09']]);   // a اشترى مرتين
  await upsertCustDays(env.DB, 'm1', [['a', '2026-09-01']]);                                              // أرشيف أقدم يُحدّث أول يوم شراء
  const s = await customerStats(env.DB, 'm1', '2026-10-01', '2026-10-31');
  assert.deepEqual([s.active, s.fresh, s.returning], [2, 1, 1]);   // a عائد (أول شراء في سبتمبر)، b جديد
  assert.equal(await customerTotal(env.DB, 'm1'), 2);
  await env.DB.prepare('DELETE FROM cust_first').run();
  await initCustFirst(env.DB, 'm1');
  assert.equal(await customerTotal(env.DB, 'm1'), 2);
  assert.equal((await customerStats(env.DB, 'm1', '2026-09-01', '2026-09-30')).fresh, 1);
});

test('migration: catalog seeded from legacy prices; one-time reprice drops older days and refills them', async () => {
  clearPriceCache();
  const env = setup({ CATALOG_SYNC: 'off', INVENTORY_SYNC: 'off', BACKFILL_DAYS: '45' });
  await ensureSchema(env.DB);
  await env.DB.prepare("INSERT INTO prices (merchant, name, price, img) VALUES ('m1', 'dress', 55, '')").run();
  const get = fakeSalla({ perDay: 3 });
  let t = NOW;
  for (let i = 0; i < 80; i++, t += 60000) if ((await syncMerchant(env, 'm1', { get }, t)).backfillDone) break;
  const { readCatalog, setMeta } = await import('../src/db.js');
  assert.equal((await readCatalog(env.DB, 'm1'))[0].price, 55);                       // بُذر من الأسعار القديمة
  assert.equal((await rangeRows(env.DB, 'm1', addDays(TODAY, -45), TODAY)).length, 46);
  const st = await getMeta(env.DB, 'm1', 'state', {});
  await setMeta(env.DB, 'm1', 'state', { ...st, catFull: 2, repriced: false });
  const r = await syncMerchant(env, 'm1', { get }, t); t += 60000;
  assert.ok(r.log && r.log.includes('reprice'), JSON.stringify(r));
  for (let i = 0; i < 60; i++, t += 60000) await syncMerchant(env, 'm1', { get }, t);
  assert.equal((await rangeRows(env.DB, 'm1', addDays(TODAY, -45), TODAY)).length, 46);  // وأُعيد جلبها
});
