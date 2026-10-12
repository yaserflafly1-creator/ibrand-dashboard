import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1, makeKV, fakeSalla } from './helpers.js';
import { syncMerchant, addDays, clearPriceCache } from '../src/sync.js';
import { ensureSchema, rangeRows, coverage, getMeta, readInventory } from '../src/db.js';

const NOW = Date.parse('2026-10-12T09:00:00Z');   // 12:00 الرياض
const TODAY = '2026-10-12';
const setup = (over = {}) => ({ DB: makeD1(), TOKENS: makeKV(), BACKFILL_DAYS: '60', SYNC_BUDGET: '40', ...over });

test('first run loads inventory first, then orders; prices come from inventory', async () => {
  clearPriceCache();
  const env = setup(); const calls = [];
  const get = fakeSalla({ perDay: 4, calls });
  let r = await syncMerchant(env, 'm1', { get }, NOW);
  assert.deepEqual(r.log.slice(0, 2), ['inventory', 'recent']);   // المخزون ثم الأحدث، والأسعار جاهزة في نفس التشغيل
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
  const env = setup({ BACKFILL_DAYS: '10', SYNC_BUDGET: '30' });
  const get = fakeSalla({ perDay: 200 });      // ~7 صفحات لليوم: الدفعة الأولى لا تتسع
  const r1 = await syncMerchant(env, 'm1', { get }, NOW);
  assert.ok(r1.used <= 30);
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
  assert.equal(st.schema, 2);
  assert.ok(st.backfillDone === false || st.backfillNext !== null || st.resyncNext, 'backfill restarted');
});
