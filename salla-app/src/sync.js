// مزامنة الخلفية (Cron): تجلب الطلبات من سلة على دفعات صغيرة وتحفظ ملخصات يومية في D1.
// نحترم قيود سلة (30 طلباً في الصفحة، صفحات متسلسلة) وحد نداءات Cloudflare لكل تشغيل (SYNC_BUDGET).
import { normalizeOrder, normalizeInventoryItem, normalizeAttribution, buildPriceMap } from './salla.js';
import { emptyDay, addOrder, roundDay } from './agg.js';
import { ensureSchema, getMeta, setMeta, upsertDays, upsertInventory, dropOldInventory, readInventory, upsertPrices, readPrices, upsertCustDays, setDbHook, loadedDays, upsertOrderRows, pendingAttr, setAttr } from './db.js';

const DAY = 864e5;
const SCHEMA = 5;   // 5: جدول العملاء من الطلبات (تُعاد مزامنة الأرشيف مرة واحدة)
export const CAMPAIGN_DAYS_DEFAULT = 90;
export const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
export const riyadhDay = (ms) => new Date(ms + 3 * 3600e3).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY) + 1;

/* خريطة اسم المنتج -> سعر، مأخوذة من جدول المخزون (Product Quantities يحمل الاسم والسعر) */
const priceCache = new Map();
export async function priceMap(db, merchant) {
  const hit = priceCache.get(merchant);
  if (hit && hit.exp > Date.now()) return hit.map;
  const map = new Map();
  for (const r of await readPrices(db, merchant)) if (r.price > 0) map.set(r.name, { price: r.price, img: r.img });
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
  // بلا كتالوج أسعار (المخزون متوقف): نقدّر سعر الوحدة بتوزيع إجمالي الطلب على الكميات حتى لا تظهر قيم المنتجات صفراً
  const unpriced = order.lines.filter((l) => !l.price);
  if (unpriced.length && order.total > 0) {
    const qty = order.lines.reduce((s, l) => s + (l.qty || 0), 0) || 1;
    for (const l of unpriced) l.price = Math.round((order.total / qty) * 100) / 100;
  }
}

/* يجلب طلبات الأيام [a..b] ويكتب ملخصاتها. يرجع { ok, pages }؛ ok=false إن تجاوز الميزانية قبل الاكتمال (لا يُكتب شيء). */
async function syncOrdersRange(ctx, a, b) {
  // نوسّع النطاق يوماً من كل جهة (دلالة from_date/to_date في الوثيقة غير محسومة) ثم نصفّي بتاريخ الطلب نفسه
  const from = addDays(a, -1), to = addDays(b, 1);
  const days = new Map();
  for (let d = a; d <= b; d = addDays(d, 1)) days.set(d, emptyDay(d));
  let pages = 0;
  const attrRows = [], custRows = [];
  for (let page = 1; ; page++) {
    // نحجز نداءات D1 النهائية (الأيام + الطلبات + العملاء ≈ 3-5 دفعات) كي لا نتجاوز حد النداءات الفرعية
    if (ctx.used + 6 >= ctx.budget) return { ok: false, pages };
    const j = await ctx.get('/orders', { from_date: from, to_date: to, per_page: 30, page });
    pages++;
    for (const raw of j.data || []) {
      const o = normalizeOrder(raw);
      if (o.draft || o.status === 'unpaid' || !days.has(o.day)) continue;
      priceLines(o, ctx.prices);
      if (o.currency) ctx.currency = o.currency;
      addOrder(days.get(o.day), o);
      if (o.customerId != null && (o.status === 'completed' || o.status === 'shipping')) custRows.push([o.customerId, o.day]);
      if (o.day >= ctx.attrFloor && o.sallaId != null) attrRows.push({ id: o.sallaId, day: o.day, status: o.status, total: o.total });
    }
    if (page >= (j.pagination?.totalPages ?? 1)) break;
  }
  await upsertDays(ctx.db, ctx.merchant, [...days.values()].map(roundDay));
  if (attrRows.length) await upsertOrderRows(ctx.db, ctx.merchant, attrRows);
  // إحصاءات العملاء ثانوية: فشل كتابتها لا يُسقط مزامنة الطلبات
  if (custRows.length) { try { await upsertCustDays(ctx.db, ctx.merchant, custRows); } catch (e) { ctx.custError = String(e.message || e).slice(0, 120); } }
  return { ok: true, pages };
}

/* بيانات الحملة: طلب تفاصيل لكل طلب جديد (مرة واحدة فقط لكل طلب) ضمن حدود الميزانية */
async function attributionChunk(ctx, limit) {
  if (limit <= 0) return 0;
  const ids = await pendingAttr(ctx.db, ctx.merchant, ctx.attrFloor, limit);
  let done = 0;
  for (let i = 0; i < ids.length; i += 4) {
    const res = await Promise.all(ids.slice(i, i + 4).map((id) =>
      ctx.get('/orders/' + id, { format: 'light' }).then((j) => ({ id, ...normalizeAttribution(j.data) })).catch((e) => ({ id, err: String(e.message || e) }))));
    const ok = res.filter((r) => !r.err);
    // طلب محذوف (404) نعلّمه منتهياً حتى لا نكرره، وغير ذلك (429/5xx) نعيده لاحقاً
    const gone = res.filter((r) => r.err && /salla 404\b/.test(r.err)).map((r) => ({ id: r.id, src: '', med: '', camp: '' }));
    await setAttr(ctx.db, ctx.merchant, [...ok, ...gone]);
    done += ok.length + gone.length;
    if (res.some((r) => r.err && /salla 429\b/.test(r.err))) break;   // حد معدّل سلة: نتوقف حتى التشغيل التالي
  }
  return done;
}

/* دفعة أيام للخلف من المؤشر ptr حتى الحد lower. تضبط حجم الدفعة حسب متوسط الصفحات لكل يوم. */
async function chunk(ctx, state, ptr, lower) {
  const left = ctx.budget - ctx.used;
  const n = Math.max(1, Math.min(30, Math.floor((left - 7) / (state.ppd * 1.25 + 0.5))));   // نترك 6 نداءات لكتابات D1
  const start = addDays(ptr, -(n - 1)) < lower ? lower : addDays(ptr, -(n - 1));
  const span = daysBetween(start, ptr);
  let r;
  try { r = await syncOrdersRange(ctx, start, ptr); }
  catch (e) { state.ppd = Math.min(state.ppd * 2, 60); throw e; }   // تجاوز حد النداءات: نصغّر الدفعة التالية
  if (!r.ok) { state.ppd = Math.min(state.ppd * 1.5, 60); return { ptr, done: false }; }
  state.ppd = Math.max(0.4, state.ppd * 0.5 + (r.pages / (span + 2)) * 0.5);
  return { ptr: addDays(start, -1), done: start <= lower };
}

/* دفعة من كتالوج المنتجات (أسعار الوحدة): GET /products?format=light صفحة بصفحة، تُحفظ في جدول prices */
async function catalogChunk(ctx, state, now, maxCalls = Infinity) {
  let page = state.catPage || 1;
  const cap = Math.min(ctx.budget, ctx.used + maxCalls);
  while (ctx.used < cap) {
    const j = await ctx.get('/products', { format: 'light', page, per_page: 30 });
    await upsertPrices(ctx.db, ctx.merchant, buildPriceMap(j.data));
    if (page >= (j.pagination?.totalPages ?? 1)) {
      state.catPage = 1; state.catDoneOnce = true; state.catNextAt = now + 6 * 3600e3;
      clearPriceCache(); ctx.prices = await priceMap(ctx.db, ctx.merchant);
      return true;
    }
    page++; state.catPage = page;
  }
  return false;
}

/* دفعة من المخزون: صفحات Product Quantities بالتسلسل، تُحفظ في D1 */
async function inventoryChunk(ctx, state, now, maxCalls = Infinity) {
  let page = state.invPage || 1;
  const cap = Math.min(ctx.budget, ctx.used + maxCalls);
  while (ctx.used < cap) {
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
  setDbHook(() => { ctx.used++; });
  ctx.prices = await priceMap(db, merchant);

  const today = riyadhDay(now);
  ctx.attrFloor = addDays(today, -(Number(env.CAMPAIGN_DAYS) || CAMPAIGN_DAYS_DEFAULT));
  const floor = addDays(today, -(Number(env.BACKFILL_DAYS) || 400));
  state.ppd = state.ppd || 5;
  // تغيّر شكل الملخصات اليومية (v2: تفاصيل الملغية والمسترجعة): نعيد بناء الأرشيف كاملاً مرة واحدة
  if (state.schema !== SCHEMA) { state.schema = SCHEMA; state.backfillDone = false; state.backfillNext = null; state.resyncNext = addDays(today, -2); state.resyncLow = addDays(today, -30); state.deepAt = now; }
  state.invGen = state.invGen || 1;
  const log = [];
  const invOn = env.INVENTORY_SYNC !== 'off', catOn = env.CATALOG_SYNC !== 'off';

  try {
    // 1) المخزون أولاً حتى تكتمل أول دورة (نحتاجه لأسعار المنتجات)، ثم كل ساعة
    const invDue = !state.invDoneOnce || (state.invNextAt || 0) <= now || (state.invPage || 1) > 1;
    // أي فشل في المخزون (صلاحية/حد معدّل/كتالوج ضخم) لا يوقف مزامنة الطلبات؛ ونحجز نصف الميزانية للطلبات
    const invOk = async (cap) => {
      try { await inventoryChunk(ctx, state, now, cap); state.invError = ''; }
      catch (e) { state.invError = String(e.message || e).slice(0, 120); state.invTries = (state.invTries || 0) + 1; }
      log.push('inventory');
    };
    if (invOn && !state.invDoneOnce && invDue) await invOk(Math.floor(ctx.budget / 2));
    // بعد ١٥ محاولة متعثرة نكمل الطلبات دون أسعار المنتجات بدل أن تتوقف اللوحة
    const catDue = catOn && (!state.catDoneOnce || (state.catNextAt || 0) <= now || (state.catPage || 1) > 1);
    const catRun = async (cap) => {
      try { await catalogChunk(ctx, state, now, cap); state.catError = ''; }
      catch (e) { state.catError = String(e.message || e).slice(0, 120); state.catTries = (state.catTries || 0) + 1; }
      log.push('catalog');
    };
    if (catDue && !state.catDoneOnce) await catRun(Math.floor((ctx.budget - ctx.used) / 2));
    const ready = (!invOn || state.invDoneOnce || (state.invTries || 0) >= 15) && (!catOn || state.catDoneOnce || (state.catTries || 0) >= 15);

    // 2) أحدث يومين: كل ~5 دقائق
    if (ctx.used < ctx.budget && now - (state.lastRecent || 0) > 270000) {
      const r = await syncOrdersRange(ctx, addDays(today, -1), today);
      if (r.ok) { state.lastRecent = now; log.push('recent'); }
    }

    // 2b) بيانات الحملات للطلبات الجديدة (ثلث الميزانية المتبقية كحد أقصى كي لا تتأخر بقية المزامنة)
    if (ready && ctx.used < ctx.budget) {
      // أثناء تحميل الأرشيف نترك للطلبات الحصة الأكبر (الحملات تكتمل لاحقاً)
      const share = state.backfillDone ? Math.floor((ctx.budget - ctx.used) / 3) : Math.min(4, Math.floor((ctx.budget - ctx.used) / 6));
      const n = await attributionChunk(ctx, share);
      if (n) log.push('attribution');
    }

    // 3) إعادة مزامنة آخر 30 يوماً كل ساعة (لالتقاط تغيّر الحالات)، ثم 4) استكمال الأرشيف التاريخي
    const hour = Math.floor(now / 3600e3);
    // كل ساعة: إعادة مزامنة آخر 7 أيام (الحالات تتغير غالباً خلالها)؛ وكل 12 ساعة: 30 يوماً كاملة
    // لا نقطع إعادة مزامنة جارية (كان هذا يترك فجوة بين نافذة الـ7 أيام والأرشيف)
    if (state.lastResyncHour !== hour && !state.resyncNext) {
      const first = state.lastResyncHour === undefined;
      state.lastResyncHour = hour; state.resyncNext = addDays(today, -2);
      const deep = first || now - (state.deepAt || 0) > 12 * 3600e3;   // أول مرة: 30 يوماً
      if (deep) state.deepAt = now;
      state.resyncLow = addDays(today, deep ? -30 : -7);
    }
    const lowWanted = state.resyncLow || addDays(today, -30);
    const resyncLow = lowWanted < floor ? floor : lowWanted;
    if (state.resyncNext && state.resyncNext < resyncLow) state.resyncNext = null;
    if (state.resyncNext && ctx.used < ctx.budget && ready) {
      const r = await chunk(ctx, state, state.resyncNext, resyncLow);
      state.resyncNext = r.done ? null : r.ptr; log.push('resync');
    } else if (ready && ctx.used < ctx.budget && (!state.backfillDone || state.lastGapHour !== hour)) {
      // الأرشيف بالاكتشاف لا بالمؤشر: نملأ أحدث مقطع أيام مفقودة (أي يوم بلا صف)، فلا تبقى فجوات مهما انقطعت المزامنة
      ctx.used++;   // قراءة D1
      const have = new Set(await loadedDays(db, merchant, floor, today));
      let hi = null;
      for (let d = today; d >= floor; d = addDays(d, -1)) if (!have.has(d)) { hi = d; break; }
      if (!hi) { state.backfillDone = true; state.backfillNext = null; state.lastGapHour = hour; }
      else {
        let lo = hi;
        while (lo > floor && !have.has(addDays(lo, -1))) lo = addDays(lo, -1);
        state.backfillDone = false; state.backfillNext = hi;
        await chunk(ctx, state, hi, lo); log.push('backfill');
      }
    }

    // 5) تحديث المخزون الدوري إن بقيت ميزانية
    if (catDue && state.catDoneOnce && ctx.used < ctx.budget) await catRun();
    if (invOn && state.invDoneOnce && ctx.used < ctx.budget && ((state.invNextAt || 0) <= now || (state.invPage || 1) > 1)) {
      await invOk();
    }
    if (ctx.currency) state.currency = ctx.currency;
    state.lastError = '';
    state.custError = ctx.custError || state.custError || '';
    state.lastRunAt = now; state.lastLog = log.slice(0, 6); state.lastUsed = ctx.used;
  } catch (e) {
    state.lastError = String(e.message || e).slice(0, 160); state.lastErrorAt = now;
    throw e;
  } finally {
    setDbHook(null);
    state.lockUntil = 0;
    await setMeta(db, merchant, 'state', state);
  }
  return { used: ctx.used, log, backfillDone: !!state.backfillDone };
}
