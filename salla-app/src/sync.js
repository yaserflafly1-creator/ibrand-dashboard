// مزامنة الخلفية (Cron): تجلب الطلبات من سلة على دفعات صغيرة وتحفظ ملخصات يومية في D1.
// نحترم قيود سلة (30 طلباً في الصفحة، صفحات متسلسلة) وحد نداءات Cloudflare لكل تشغيل (SYNC_BUDGET).
import { normalizeOrder, normalizeInventoryItem } from './salla.js';
import { emptyDay, addOrder, roundDay } from './agg.js';
import { ensureSchema, getMeta, setMeta, upsertDays, upsertInventory, dropOldInventory, readInventory } from './db.js';

const DAY = 864e5;
export const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
export const riyadhDay = (ms) => new Date(ms + 3 * 3600e3).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY) + 1;

/* خريطة اسم المنتج -> سعر، مأخوذة من جدول المخزون (Product Quantities يحمل الاسم والسعر) */
const priceCache = new Map();
export async function priceMap(db, merchant) {
  const hit = priceCache.get(merchant);
  if (hit && hit.exp > Date.now()) return hit.map;
  const map = new Map();
  for (const it of await readInventory(db, merchant)) {
    const key = String(it.name).trim().toLowerCase();
    if (it.price > 0 && !map.has(key)) map.set(key, { price: it.price, img: it.img });
  }
  priceCache.set(merchant, { map, exp: Date.now() + 600e3 });
  return map;
}
export const clearPriceCache = () => priceCache.clear();

export function priceLines(order, map) {
  for (const l of order.lines) {
    const hit = map.get(String(l.name).trim().toLowerCase());
    if (hit) { l.price = hit.price; l.img = l.img || hit.img; }
  }
}

/* يجلب طلبات الأيام [a..b] ويكتب ملخصاتها. يرجع { ok, pages }؛ ok=false إن تجاوز الميزانية قبل الاكتمال (لا يُكتب شيء). */
async function syncOrdersRange(ctx, a, b) {
  // نوسّع النطاق يوماً من كل جهة (دلالة from_date/to_date في الوثيقة غير محسومة) ثم نصفّي بتاريخ الطلب نفسه
  const from = addDays(a, -1), to = addDays(b, 1);
  const days = new Map();
  for (let d = a; d <= b; d = addDays(d, 1)) days.set(d, emptyDay(d));
  let pages = 0;
  for (let page = 1; ; page++) {
    if (ctx.used >= ctx.budget) return { ok: false, pages };
    const j = await ctx.get('/orders', { from_date: from, to_date: to, per_page: 30, page });
    pages++;
    for (const raw of j.data || []) {
      const o = normalizeOrder(raw);
      if (o.draft || o.status === 'unpaid' || !days.has(o.day)) continue;
      priceLines(o, ctx.prices);
      if (o.currency) ctx.currency = o.currency;
      addOrder(days.get(o.day), o);
    }
    if (page >= (j.pagination?.totalPages ?? 1)) break;
  }
  await upsertDays(ctx.db, ctx.merchant, [...days.values()].map(roundDay));
  return { ok: true, pages };
}

/* دفعة أيام للخلف من المؤشر ptr حتى الحد lower. تضبط حجم الدفعة حسب متوسط الصفحات لكل يوم. */
async function chunk(ctx, state, ptr, lower) {
  const left = ctx.budget - ctx.used;
  const n = Math.max(1, Math.min(30, Math.floor((left - 1) / (state.ppd * 1.25 + 0.5))));
  const start = addDays(ptr, -(n - 1)) < lower ? lower : addDays(ptr, -(n - 1));
  const span = daysBetween(start, ptr);
  const r = await syncOrdersRange(ctx, start, ptr);
  if (!r.ok) { state.ppd = Math.min(state.ppd * 1.5, 60); return { ptr, done: false }; }
  state.ppd = Math.max(0.4, state.ppd * 0.5 + (r.pages / (span + 2)) * 0.5);
  return { ptr: addDays(start, -1), done: start <= lower };
}

/* دفعة من المخزون: صفحات Product Quantities بالتسلسل، تُحفظ في D1 */
async function inventoryChunk(ctx, state, now) {
  let page = state.invPage || 1;
  while (ctx.used < ctx.budget) {
    const j = await ctx.get('/products/quantities', { page });
    await upsertInventory(ctx.db, ctx.merchant, state.invGen, (j.data || []).map(normalizeInventoryItem));
    if (page >= (j.pagination?.totalPages ?? 1)) {
      await dropOldInventory(ctx.db, ctx.merchant, state.invGen);
      state.invGen++; state.invPage = 1; state.invDoneOnce = true; state.invNextAt = now + 3600e3; state.invUpdatedAt = now;
      clearPriceCache();
      ctx.prices = await priceMap(ctx.db, ctx.merchant);   // الأسعار الجديدة متاحة لبقية هذا التشغيل
      return true;
    }
    page++; state.invPage = page;
  }
  return false;
}

export async function syncMerchant(env, merchant, ctxBase, now = Date.now()) {
  const db = env.DB;
  await ensureSchema(db);
  const state = await getMeta(db, merchant, 'state', {});
  if (state.lockUntil && state.lockUntil > now) return { skipped: 'locked' };
  state.lockUntil = now + 55000;
  await setMeta(db, merchant, 'state', state);

  const ctx = { ...ctxBase, db, merchant, used: 0, budget: Number(env.SYNC_BUDGET) || 40, currency: state.currency };
  const get = ctxBase.get;
  ctx.get = async (path, params) => { ctx.used++; return get(path, params); };
  ctx.prices = await priceMap(db, merchant);

  const today = riyadhDay(now);
  const floor = addDays(today, -(Number(env.BACKFILL_DAYS) || 400));
  state.ppd = state.ppd || 5;
  state.invGen = state.invGen || 1;
  const log = [];

  try {
    // 1) المخزون أولاً حتى تكتمل أول دورة (نحتاجه لأسعار المنتجات)، ثم كل ساعة
    const invDue = !state.invDoneOnce || (state.invNextAt || 0) <= now || (state.invPage || 1) > 1;
    if (!state.invDoneOnce && invDue) { await inventoryChunk(ctx, state, now); log.push('inventory'); }

    // 2) أحدث يومين: كل ~5 دقائق
    if (ctx.used < ctx.budget && now - (state.lastRecent || 0) > 270000) {
      const r = await syncOrdersRange(ctx, addDays(today, -1), today);
      if (r.ok) { state.lastRecent = now; log.push('recent'); }
    }

    // 3) إعادة مزامنة آخر 30 يوماً كل ساعة (لالتقاط تغيّر الحالات)، ثم 4) استكمال الأرشيف التاريخي
    const hour = Math.floor(now / 3600e3);
    if (state.lastResyncHour !== hour) { state.lastResyncHour = hour; state.resyncNext = addDays(today, -2); }
    const resyncLow = addDays(today, -30) < floor ? floor : addDays(today, -30);
    if (state.resyncNext && state.resyncNext < resyncLow) state.resyncNext = null;
    if (state.resyncNext && ctx.used < ctx.budget && state.invDoneOnce) {
      const r = await chunk(ctx, state, state.resyncNext, resyncLow);
      state.resyncNext = r.done ? null : r.ptr; log.push('resync');
    } else if (!state.backfillDone && ctx.used < ctx.budget && state.invDoneOnce) {
      state.backfillNext = state.backfillNext || addDays(today, -31);
      if (state.backfillNext < floor) state.backfillDone = true;
      else {
        const r = await chunk(ctx, state, state.backfillNext, floor);
        state.backfillNext = r.ptr; if (r.done) state.backfillDone = true; log.push('backfill');
      }
    }

    // 5) تحديث المخزون الدوري إن بقيت ميزانية
    if (state.invDoneOnce && ctx.used < ctx.budget && ((state.invNextAt || 0) <= now || (state.invPage || 1) > 1)) {
      await inventoryChunk(ctx, state, now); log.push('inventory');
    }
    if (ctx.currency) state.currency = ctx.currency;
  } finally {
    state.lockUntil = 0;
    await setMeta(db, merchant, 'state', state);
  }
  return { used: ctx.used, log, backfillDone: !!state.backfillDone };
}
