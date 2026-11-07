import { normalizeOrder, normalizeCoupon, normalizeShipment, mapStatus } from './salla.js';
import { sumDays, seriesOf, categoryStats, sumBaskets } from './agg.js';
import { ensureSchema, getMeta, setMeta, rangeRows, coverage, readInventory, campaignStats, customerStats, customerTotal, readCatalog, basketRows, monthlyStats, rangeTotals } from './db.js';
import { suggestFor, matchScore, normText, makeRivalIndex, rivalOf } from './suggest.js';
import { compList, compUpsert, compDelete, compIgnore, compVerify, compOne, compDue, compSave, validCompetitorUrl, checkCompetitorUrl } from './comp.js';
import { toCsv, periodRange, buildReport, REPORTS } from './export.js';
import { syncMerchant, priceMap, priceLines, catalogBlob, addDays, riyadhDay, CAMPAIGN_DAYS_DEFAULT } from './sync.js';

/* ذاكرة مؤقتة داخل الـ isolate: تخفف النداءات المتكررة دون استهلاك عمليات كتابة KV */
const memoStore = new Map();
async function memo(key, ttlMs, fn) {
  const hit = memoStore.get(key);
  if (hit && hit.exp > Date.now()) return hit.v;
  const v = await fn();
  if (memoStore.size > 120) memoStore.clear();   // ملخصات الفترات كبيرة نسبياً: نحدّ عدد المخزَّن
  memoStore.set(key, { v, exp: Date.now() + ttlMs });
  return v;
}
export const __clearMemo = () => memoStore.clear();

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

/* ---------- Webhook: استلام التوكن عند تثبيت التطبيق ---------- */
async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function handleWebhook(req, env) {
  const raw = await req.text();
  // وثيقة Webhooks: الترويسة X-Salla-Security-Strategy تحدد الاستراتيجية.
  //  - signature: X-Salla-Signature = HMAC-SHA256(hex) لنص الطلب الخام بالسر
  //  - token: السر نفسه يصل في ترويسة Authorization
  if (!env.SALLA_WEBHOOK_SECRET) return json({ error: 'webhook secret not configured' }, 500);
  const strategy = (req.headers.get('x-salla-security-strategy') || 'signature').toLowerCase();
  const ok = strategy === 'token'
    ? safeEqual((req.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''), env.SALLA_WEBHOOK_SECRET)
    : safeEqual((req.headers.get('x-salla-signature') || '').toLowerCase(), await hmacHex(env.SALLA_WEBHOOK_SECRET, raw));
  if (!ok) return json({ error: 'bad signature' }, 401);
  const evt = JSON.parse(raw);
  const merchant = String(evt.merchant ?? evt.data?.merchant ?? '');
  if (!merchant) return json({ ok: true });

  if (evt.event === 'app.store.authorize') {
    // وثيقة App Events: data = { access_token, expires (epoch بالثواني), refresh_token, scope, token_type }
    const d = evt.data || {};
    await saveTokens(env, merchant, { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Number(d.expires) * 1000 || 0 });
  } else if (evt.event === 'app.uninstalled') {
    await env.TOKENS.delete(`merchant:${merchant}`);
  }
  return json({ ok: true });
}

const saveTokens = (env, merchant, t) => env.TOKENS.put(`merchant:${merchant}`, JSON.stringify(t));
const loadTokens = async (env, merchant) => JSON.parse((await env.TOKENS.get(`merchant:${merchant}`)) || 'null');

/* ---------- هوية التاجر من توكن التطبيق المضمَّن (Token Introspect) ---------- */
async function merchantFromEmbeddedToken(req, env) {
  if ((req.headers.get('authorization') || '').startsWith('Share ')) return null;
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || new URL(req.url).searchParams.get('token');
  if (!token || !env.SALLA_APP_ID) return null;
  const cached = memoStore.get('tok:' + token);
  if (cached && cached.exp > Date.now()) return cached.v;
  // وثيقة Authentication (التطبيقات المضمَّنة): POST + ترويسة S-Source = app id، والجسم { token } فقط
  const r = await fetch(env.SALLA_INTROSPECT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 's-source': String(env.SALLA_APP_ID) },
    body: JSON.stringify({ token })
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const d = j?.data;
  // الاستجابة: { merchant_id, user_id, exp } (وصفحة Endpoint تذكر store_id/app_id لنسخة Report Builder فنقبل الاسمين)
  const id = d?.merchant_id ?? d?.store_id;
  if (!j?.success || !id) return null;
  if (d.app_id !== undefined && String(d.app_id) !== String(env.SALLA_APP_ID)) return null; // توكن تطبيق آخر
  const expMs = d.exp ? Date.parse(d.exp) : Infinity;
  if (expMs < Date.now()) return null;                                                      // منتهي
  // [VERIFY] نفترض أن merchant_id هو نفسه حقل merchant في الـ webhooks (نؤكده بتجربة فعلية)
  const merchant = String(id);
  memoStore.set('tok:' + token, { v: merchant, exp: Math.min(expMs, Date.now() + 120e3) });
  return merchant;
}

/* ---------- نداءات Salla مع تجديد التوكن ---------- */
async function refresh(env, merchant, t) {
  const r = await fetch(env.SALLA_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: t.refresh_token,
      client_id: env.SALLA_CLIENT_ID, client_secret: env.SALLA_CLIENT_SECRET
    })
  });
  if (!r.ok) throw new Error('refresh failed');
  const j = await r.json();
  const nt = { access_token: j.access_token, refresh_token: j.refresh_token || t.refresh_token, expires_at: Date.now() + (j.expires_in || 0) * 1000 };
  await saveTokens(env, merchant, nt); // refresh token يُستخدم مرة واحدة، فنحفظ الجديد فوراً
  return nt;
}

function makeClient(env, merchant, tokens) {
  let t = tokens;
  return async function sallaGet(path, params = {}) {
    // تجديد استباقي قبل انتهاء صلاحية التوكن بدقيقة
    if (t.refresh_token && t.expires_at && t.expires_at < Date.now() + 60000) t = await refresh(env, merchant, t);
    const url = new URL(env.SALLA_API_BASE + path);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const call = () => fetch(url, { headers: { authorization: `Bearer ${t.access_token}`, accept: 'application/json' } });
    let r = await call();
    if (r.status === 401 && t.refresh_token) { t = await refresh(env, merchant, t); r = await call(); }
    if (!r.ok) {
      // نلحق مختصراً من رسالة سلة (للتشخيص في شريط المزامنة؛ لا يحوي أسراراً)
      const body = await r.text().catch(() => '');
      const msg = (body.match(/"message"\s*:\s*"([^"]{1,140})"/) || [])[1] || '';
      throw new Error(`salla ${r.status} ${path}${msg ? ' ' + msg : ''}`);
    }
    return r.json();
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validRange = (q) => DATE_RE.test(q.get('from') || '') && DATE_RE.test(q.get('to') || '');

// تحقق الهوية + تجهيز عميل سلة؛ يرجع { res } عند الفشل أو { merchant, get } عند النجاح
async function authContext(req, env) {
  const merchant = await merchantFromEmbeddedToken(req, env);
  if (!merchant) return { res: json({ error: 'unauthorized' }, 401) };
  const tokens = await loadTokens(env, merchant);
  if (!tokens) return { res: json({ error: 'app not installed' }, 403) };
  return { merchant, get: makeClient(env, merchant, tokens) };
}

/* ---------- روابط المشاركة (قراءة فقط): share:<id> → { merchant, label, exp } في KV ---------- */
const SHARE_MAX_DAYS = 365, SHARE_ID_RE = /^[0-9a-f]{32}$/;
async function shareById(env, id) {
  if (!SHARE_ID_RE.test(id || '')) return null;
  const raw = await env.TOKENS.get(`share:${id}`);
  if (!raw) return null;
  const rec = JSON.parse(raw);
  return rec.exp > Date.now() ? rec : null;
}
async function shareFromRequest(req, env) {
  const m = /^Share ([0-9a-f]{32})$/.exec(req.headers.get('authorization') || '');
  return m ? shareById(env, m[1]) : null;
}
// نقاط تقرأ من D1 فقط (ملخص/مخزون): تقبل توكن سلة أو رابط مشاركة؛ الباقي (طلبات/عملاء بأسمائهم) توكن سلة فقط
async function dataContext(req, env) {
  if ((req.headers.get('authorization') || '').startsWith('Share ')) {
    const rec = await shareFromRequest(req, env);
    return rec ? { merchant: rec.merchant, shared: true } : { res: json({ error: 'unauthorized' }, 401) };
  }
  return authContext(req, env);
}
async function handleShare(req, env) {
  const merchant = await merchantFromEmbeddedToken(req, env);
  if (!merchant) return json({ error: 'unauthorized' }, 401);
  const origin = new URL(req.url).origin;
  if (req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    const days = Math.min(SHARE_MAX_DAYS, Math.max(1, Math.floor(Number(b.days)) || 7));
    const id = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('');
    const rec = { merchant, label: String(b.label || '').slice(0, 60), exp: Date.now() + days * 864e5, created: Date.now() };
    await env.TOKENS.put(`share:${id}`, JSON.stringify(rec), { expirationTtl: days * 86400 + 3600 });
    return json({ id, url: `${origin}/?share=${id}`, ...rec });
  }
  if (req.method === 'DELETE') {
    const id = new URL(req.url).searchParams.get('id') || '';
    if (!SHARE_ID_RE.test(id)) return json({ error: 'bad id' }, 400);
    const raw = await env.TOKENS.get(`share:${id}`);
    if (raw && JSON.parse(raw).merchant === merchant) await env.TOKENS.delete(`share:${id}`);
    return json({ ok: true });
  }
  const { keys } = await env.TOKENS.list({ prefix: 'share:' });
  const out = [];
  for (const k of keys) {
    const raw = await env.TOKENS.get(k.name);
    const rec = raw && JSON.parse(raw);
    if (rec && rec.merchant === merchant && rec.exp > Date.now()) { const id = k.name.slice(6); out.push({ id, url: `${origin}/?share=${id}`, ...rec }); }
  }
  return json({ shares: out.sort((a, b) => b.created - a.created) });
}

const catInfo = (env, merchant) => memo(`catmap:${merchant}`, 600e3, async () => {
  const rows2 = await catalogBlob(env.TOKENS, env.DB, merchant), vat = 1 + (Number(env.VAT_RATE) || 15) / 100;
  return { cats: new Map(rows2.filter((r) => r.cat).map((r) => [r.name, r.cat])), vat: new Map(rows2.filter((r) => r.taxable !== 0).map((r) => [r.name, vat])), size: rows2.length };
});

/* ---------- /api/export.csv: تقارير إجمالية لجوجل شيت (IMPORTDATA لا يرسل ترويسات، فالرابط يحمل share في الاستعلام) ---------- */
const ORDERS_EXPORT_MAX_DAYS = 31, ORDERS_EXPORT_MAX_PAGES = 300;
const UNAVAILABLE_RE = /عدم\s*توفر|غير\s*متوفر|نفد|نفاد/;   // سبب الإلغاء تكتبه الفروع كملاحظة في سجل الطلب (مثل «عدم توفر المنتج»)
const UNAVAIL_MAX_PAGES = 150, UNAVAIL_MAX_ORDERS = 700;      // سقف نداءات سلة في الطلب الواحد (حد النداءات الفرعية 1000)
const pool = async (items, n, fn) => { const out = []; for (let i = 0; i < items.length; i += n) out.push(...await Promise.all(items.slice(i, i + n).map(fn))); return out; };
async function handleExport(req, env) {
  const q = new URL(req.url).searchParams;
  const rec = await shareById(env, q.get('share'));
  const text = (s, status = 200) => new Response(s, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  if (!rec) return text('unauthorized', 401);
  const report = q.get('report') || 'summary';
  if (!REPORTS.includes(report) && !['orders', 'unavailable'].includes(report)) return text('unknown report: ' + REPORTS.join(', '), 400);
  const { from, to } = periodRange(q.get('period') || 'month', riyadhDay(Date.now()), q.get('from'), q.get('to'));
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
  if (report === 'orders') {   // قيمة كل طلب وتاريخه فقط (بلا اسم عميل): تُجلب من سلة عند الطلب فنحدّ الفترة
    if (span > ORDERS_EXPORT_MAX_DAYS) return text(`orders report allows up to ${ORDERS_EXPORT_MAX_DAYS} days`, 400);
    const want = ['all', 'canceled'].includes(q.get('status')) ? q.get('status') : 'valid';
    const body = await memo(`csvo:${rec.merchant}:${from}:${to}:${want}`, 300e3, async () => {
      const tokens = await loadTokens(env, rec.merchant);
      if (!tokens) throw new Error('salla 403 app not installed');
      const get = makeClient(env, rec.merchant, tokens);
      const rows = [];
      const take = (j) => {
        for (const o of j.data || []) {
          const day = String(o.date?.date || '').slice(0, 10);
          if (o.draft || day < from || day > to) continue;
          const st = mapStatus(o.status?.slug);
          if (want === 'valid' ? ['canceled', 'refunded', 'unpaid'].includes(st) : want === 'canceled' ? st !== 'canceled' : false) continue;
          rows.push([String(o.date.date).slice(0, 16), Math.round((Number(o.total?.amount) || 0) * 100) / 100]);
        }
      };
      const fetchPage = (page) => get('/orders', { from_date: addDays(from, -1), to_date: addDays(to, 1), per_page: 30, page });
      const first = await fetchPage(1);   // الصفحة الأولى وحدها (تجدّد التوكن إن لزم)، ثم الباقي دفعات متوازية لتفادي مهلة جوجل شيت
      take(first);
      const pages = first.pagination?.totalPages || 1;
      if (pages > ORDERS_EXPORT_MAX_PAGES) throw Object.assign(new Error('too many orders: use a shorter range'), { tooMany: true });   // لا نقصّ البيانات بصمت
      for (let p = 2; p <= pages; p += 8) {
        const batch = await Promise.all(Array.from({ length: Math.min(8, pages - p + 1) }, (_, k) => fetchPage(p + k)));
        batch.forEach(take);
      }
      rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
      return '\uFEFF' + toCsv([['التاريخ', 'قيمة الطلب'], ...rows]);
    }).catch((e) => (e.tooMany ? e : Promise.reject(e)));
    if (body instanceof Error) return text(body.message, 400);
    return new Response(body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store' } });
  }
  if (report === 'unavailable') {   // أصناف الطلبات الملغية بسبب «عدم توفر المنتج» (من ملاحظة سجل الطلب): صنف في كل سطر
    if (span > ORDERS_EXPORT_MAX_DAYS) return text(`unavailable report allows up to ${ORDERS_EXPORT_MAX_DAYS} days`, 400);
    const limit = Math.min(3000, Math.max(1, Math.floor(Number(q.get('limit'))) || 1000));
    const body = await memo(`csvu:${rec.merchant}:${from}:${to}:${limit}`, 600e3, async () => {
      const tokens = await loadTokens(env, rec.merchant);
      if (!tokens) throw new Error('salla 403 app not installed');
      const get = makeClient(env, rec.merchant, tokens);
      const fetchPage = (page) => get('/orders', { from_date: addDays(from, -1), to_date: addDays(to, 1), per_page: 30, page });
      const first = await fetchPage(1), pages = first.pagination?.totalPages || 1;
      if (pages > UNAVAIL_MAX_PAGES) throw Object.assign(new Error('too many orders: use a shorter range'), { tooMany: true });
      const batches = [first, ...(pages > 1 ? await pool(Array.from({ length: pages - 1 }, (_, k) => k + 2), 8, fetchPage) : [])];
      const canceled = batches.flatMap((j) => j.data || []).filter((o) => !o.draft && mapStatus(o.status?.slug) === 'canceled' && String(o.date?.date || '').slice(0, 10) >= from && String(o.date?.date || '').slice(0, 10) <= to);
      if (canceled.length > UNAVAIL_MAX_ORDERS) throw Object.assign(new Error('too many canceled orders: use a shorter range'), { tooMany: true });
      const hits = await pool(canceled, 8, async (o) => {
        const h = await get(`/orders/${o.id}/histories`, {});
        return (h.data || []).some((e) => (e.customized?.slug === 'canceled' || e.status === 'ملغي') && UNAVAILABLE_RE.test(String(e.note || ''))) ? o : null;
      });
      const rows = [];
      for (const o of hits.filter(Boolean)) {   // الأحدث أولاً: عند بلوغ الحد نقصّ الأقدم
        for (const it of o.items || []) {
          if (rows.length >= limit) break;
          rows.push([String(o.date.date).slice(0, 10), o.reference_id ?? o.id, it.name || '', Number(it.quantity) || 1, Math.round((Number(o.total?.amount) || 0) * 100) / 100]);
        }
      }
      rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return '\uFEFF' + toCsv([['التاريخ', 'رقم الطلب', 'الصنف', 'الكمية', 'قيمة الطلب'], ...rows]);
    }).catch((e) => (e.tooMany ? e : Promise.reject(e)));
    if (body instanceof Error) return text(body.message, 400);
    return new Response(body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store' } });
  }
  if (span > 800) return text('range too long', 400);
  const body = await memo(`csv:${rec.merchant}:${report}:${from}:${to}`, to < riyadhDay(Date.now()) ? 600e3 : 120e3, async () => {
    await ensureSchema(env.DB);
    const rows = await rangeRows(env.DB, rec.merchant, from, to);
    const cat = (report === 'categories' || report === 'products') ? await catInfo(env, rec.merchant) : null;
    return '\uFEFF' + toCsv(buildReport(report, rows, { catMap: cat?.cats, vatMap: cat?.vat }));
  });
  return new Response(body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store' } });
}

/* ---------- /api/summary: أرقام الفترة والفترة السابقة من الملخصات اليومية ---------- */
async function handleSummary(req, env) {
  const ctx = await dataContext(req, env);
  if (ctx.res) return ctx.res;
  const q = new URL(req.url).searchParams;
  if (!validRange(q)) return json({ error: 'bad range' }, 400);
  let from = q.get('from'), to = q.get('to');
  if (from > to) [from, to] = [to, from];
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
  if (days > 800) return json({ error: 'range too long' }, 400);
  const prevTo = addDays(from, -1), prevFrom = addDays(prevTo, -(days - 1));

  // ذاكرة مؤقتة داخل الـ isolate للاستجابة (والمشاهدون والتحديث التلقائي يتشاركونها): الحساب ثقيل على معالج الخطة المجانية
  const ttl = to < riyadhDay(Date.now()) ? 600e3 : 45e3;   // فترة منتهية: 10 دقائق؛ تشمل اليوم: 45 ثانية
  const text = await memo(`summary:${ctx.merchant}:${from}:${to}`, ttl, async () => {
    await ensureSchema(env.DB);
    const rows = await rangeRows(env.DB, ctx.merchant, prevFrom, to);
    const curRows = rows.filter((d) => d.day >= from), prevRows = rows.filter((d) => d.day < from);
    const state = await getMeta(env.DB, ctx.merchant, 'state', {});
    const cov = await coverage(env.DB, ctx.merchant);
    const campaigns = await memo(`camp:${ctx.merchant}:${from}:${to}`, to < riyadhDay(Date.now()) ? 3 * 3600e3 : 30 * 60e3, () => campaignStats(env.DB, ctx.merchant, from, to));   // يقرأ آلاف الصفوف: تخزين مؤقت أطول (حد القراءة اليومي)
    campaigns.since = addDays(riyadhDay(Date.now()), -(Number(env.CAMPAIGN_DAYS) || CAMPAIGN_DAYS_DEFAULT));
    // التصنيفات والضريبة: تصنيف كل منتج وعامل الضريبة (VAT_RATE، الافتراضي 15%) للمنتجات الخاضعة لها من الكتالوج
    const cat = await catInfo(env, ctx.merchant);
    const catCur = categoryStats(curRows, cat.cats, cat.vat), catPrev = categoryStats(prevRows, cat.cats, cat.vat);
    const prevByName = new Map(catPrev.list.map((c) => [c.name, c.total]));
    const categories = { total: catCur.total, units: catCur.units, mapped: cat.cats.size > 0, vat: true, catalogSize: cat.size, categorized: cat.cats.size, fmt: state.catFmt || 'light',
      list: catCur.list.map((c) => ({ ...c, prevTotal: prevByName.get(c.name) ?? 0 })) };
    const out = {
      cur: sumDays(curRows, true, cat.vat), prev: sumDays(prevRows, false, cat.vat), series: seriesOf(curRows), campaigns, categories,
      currency: state.currency || 'SAR',
      sync: { ...cov, backfillDone: !!state.backfillDone, inventoryOff: env.INVENTORY_SYNC === 'off', inventoryReady: !!state.invDoneOnce, lastRecent: state.lastRecent || 0, catalogReady: !!state.catDoneOnce, dateMode: state.dateMode || '',
        stage: (env.CATALOG_SYNC !== 'off' && !state.catDoneOnce) ? 'catalog' : state.resyncNext ? 'resync' : state.backfillDone ? 'done' : 'backfill',
        catPage: state.catPage || 1, resyncNext: state.resyncNext || null, backfillNext: state.backfillNext || null, lastRunAt: state.lastRunAt || 0, lastLog: state.lastLog || [], lastUsed: state.lastUsed || 0, error: state.lastError || (env.INVENTORY_SYNC === 'off' ? '' : state.invError) || state.catError || '' }
    };
    return JSON.stringify(out);
  });
  return new Response(text, { headers: { 'content-type': 'application/json' } });
}

/* ---------- /api/basket: تحليل سلة المشتريات للفترة (من جدول basket_day) ---------- */
async function handleBasket(req, env) {
  const ctx = await dataContext(req, env);
  if (ctx.res) return ctx.res;
  const q = new URL(req.url).searchParams;
  if (!validRange(q)) return json({ error: 'bad range' }, 400);
  let from = q.get('from'), to = q.get('to');
  if (from > to) [from, to] = [to, from];
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
  if (days > 800) return json({ error: 'range too long' }, 400);
  const ttl = to < riyadhDay(Date.now()) ? 600e3 : 60e3;
  const text = await memo(`basket:${ctx.merchant}:${from}:${to}`, ttl, async () => {
    await ensureSchema(env.DB);
    const rows = await basketRows(env.DB, ctx.merchant, from, to);
    return JSON.stringify({ ...sumBaskets(rows, 10), daysLoaded: rows.length, days });
  });
  return new Response(text, { headers: { 'content-type': 'application/json' } });
}

/* ---------- /api/months: آخر N شهراً + المتوسط الشهري (الأشهر الكاملة فقط) ---------- */
const r2n = (n) => Math.round((Number(n) || 0) * 100) / 100;
export function monthsReport(rows, today) {
  const cur = today.slice(0, 7), dim = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
  const months = rows.map((x) => ({ ...x, revenue: r2n(x.revenue), canceledValue: r2n(x.canceledValue), aov: x.orders ? r2n(x.revenue / x.orders) : 0, daysInMonth: dim(x.m), complete: x.m < cur && x.days >= dim(x.m) }));
  const full = months.filter((x) => x.complete), n = full.length;
  const sum = (k) => full.reduce((a, x) => a + x[k], 0);
  const best = full.slice().sort((a, b) => b.revenue - a.revenue)[0] || null, worst = full.slice().sort((a, b) => a.revenue - b.revenue)[0] || null;
  const avg = { months: n, revenue: n ? r2n(sum('revenue') / n) : 0, orders: n ? Math.round(sum('orders') / n) : 0, units: n ? Math.round(sum('units') / n) : 0,
    canceled: n ? Math.round(sum('canceled') / n) : 0, aov: sum('orders') ? r2n(sum('revenue') / sum('orders')) : 0, perDay: sum('days') ? r2n(sum('revenue') / sum('days')) : 0,
    best: best && { m: best.m, revenue: best.revenue }, worst: worst && { m: worst.m, revenue: worst.revenue } };
  return { months, avg, current: cur };
}
async function handleMonths(req, env) {
  const ctx = await dataContext(req, env);
  if (ctx.res) return ctx.res;
  const n = Math.min(13, Math.max(2, Math.floor(Number(new URL(req.url).searchParams.get('n'))) || 12));
  const today = riyadhDay(Date.now());
  const first = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 - (n - 1), 1)).toISOString().slice(0, 10);
  const text = await memo(`months:${ctx.merchant}:${n}`, 120e3, async () => {
    await ensureSchema(env.DB);
    return JSON.stringify(monthsReport(await monthlyStats(env.DB, ctx.merchant, first, today), today));
  });
  return new Response(text, { headers: { 'content-type': 'application/json' } });
}

/* ---------- /api/search-gaps: ما يبحث عنه الزوار ولا نملكه (من خدمة ibrand-search؛ للمشتريات) ----------
   الرقم السري REPORT_KEY سر Worker يُقرأ من الخادم فقط ولا يصل المتصفح. متاح بتوكن سلة وبرابط المشاركة (قرار صاحب المشروع؛ خدمة البحث تحجب الجوال والبريد)، وفي المشاركة نُرسل أول 50 عبارة فقط من كل قائمة */
const SHARE_GAP_ROWS = 50;
const SEARCH_CACHE_MS = 60e3;
const SEARCH_DEFAULT_URL = 'https://ibrand-search.ibrandsales.workers.dev/report/data';
const gapRows = (a) => (Array.isArray(a) ? a : []).slice(0, 500).map((x) => ({ q: String(x?.q ?? '').slice(0, 120), total: Number(x?.total) || 0, zero: Number(x?.zero) || 0, results: Number(x?.results) || 0, first: Number(x?.first) || 0, last: Number(x?.last) || 0 }));
async function handleSearchGaps(req, env) {
  const ctx = await dataContext(req, env);
  if (ctx.res) return ctx.res;
  if (!env.REPORT_KEY) return json({ error: 'not_configured' });
  try {
    const cut = (text) => { if (!ctx.shared) return text; const d = JSON.parse(text); for (const k of ['missing', 'codes', 'recovered', 'top']) d[k] = d[k].slice(0, SHARE_GAP_ROWS); return JSON.stringify(d); };
    const hit = memoStore.get('searchgaps');
    if (hit && hit.exp > Date.now()) return new Response(cut(hit.v), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    const init = { headers: { 'x-report-key': env.REPORT_KEY } };
    const r = env.SEARCH ? await env.SEARCH.fetch('https://search.internal/report/data', init) : await fetch(env.SEARCH_URL || SEARCH_DEFAULT_URL, init);
    if (r.status === 401) return json({ error: 'bad_key' });
    if (r.status === 503) return json({ error: 'disabled' });
    if (!r.ok) return json({ error: 'unreachable', status: r.status });
    const d = await r.json();
    const t = d.totals || {};
    const text = JSON.stringify({ generated_at: Number(d.generated_at) || 0, totals: { searches: Number(t.searches) || 0, zero_searches: Number(t.zero_searches) || 0, missing_phrases: Number(t.missing_phrases) || 0, recovered_phrases: Number(t.recovered_phrases) || 0 },
      missing: gapRows(d.missing), codes: gapRows(d.codes), recovered: gapRows(d.recovered), top: gapRows(d.top) });
    if (memoStore.size > 120) memoStore.clear();
    memoStore.set('searchgaps', { v: text, exp: Date.now() + SEARCH_CACHE_MS });   // ذاكرة مؤقتة داخل الـ isolate فقط (لا KV ولا D1 ولا Cache API) لدقيقة؛ أخطاء الخدمة لا تُخزَّن
    return new Response(cut(text), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch (e) { return json({ error: 'unreachable' }); }
}

/* ---------- /api/care-orders: الطلبات المنشأة من فريق خدمة العملاء (طلبات عليها وسم «Customer Care Team») ----------
   يُفلتر في سلة بمعرّف الوسم (CARE_TAG_ID). أرقام مجمّعة فقط بلا بيانات عملاء، فتُتاح أيضاً عبر روابط المشاركة. */
const CARE_MAX_PAGES = 100, CARE_DEFAULT_TAG = '52805995';
/* وسوم خدمة العملاء: «Customer Care Team» و«customer Care Team» وسمان مختلفان في سلة. نقرأ قائمة وسوم الطلبات ونطابق الاسم بلا حساسية لحالة الأحرف،
   ونضيف المعرّفات من CARE_TAG_IDS (مفصولة بفاصلة) احتياطاً إن تعذّرت قراءة القائمة */
const careTagIds = (env, merchant, get) => memo(`caretags:${merchant}`, 600e3, async () => {
  const ids = new Set(String(env.CARE_TAG_IDS || env.CARE_TAG_ID || CARE_DEFAULT_TAG).split(',').map((x) => x.trim()).filter(Boolean));
  try { const j = await get('/orders/tags', {}); for (const t of j.data || []) if (/^customer care team$/i.test(String(t.name || '').trim())) ids.add(String(t.id)); } catch (e) { /* القائمة غير متاحة: نكتفي بالمعرّفات المضبوطة */ }
  return [...ids];
});
async function handleCare(req, env) {
  const ctx = await dataContext(req, env);
  if (ctx.res) return ctx.res;
  const q = new URL(req.url).searchParams;
  if (!validRange(q)) return json({ error: 'bad range' }, 400);
  let from = q.get('from'), to = q.get('to');
  if (from > to) [from, to] = [to, from];
  if (Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1 > 800) return json({ error: 'range too long' }, 400);
  const ttl = to < riyadhDay(Date.now()) ? 600e3 : 90e3;
  const wantList = q.get('list') === '1' && !ctx.shared;   // قائمة الطلبات (رقم/تاريخ/حالة/قيمة) بلا بيانات عملاء؛ لتوكن سلة فقط
  try {
    const text = await memo(`care:${ctx.merchant}:${from}:${to}:${wantList ? 'l' : ''}`, ttl, async () => {
      const get = ctx.get || makeClient(env, ctx.merchant, await (async () => { const t = await loadTokens(env, ctx.merchant); if (!t) throw new Error('salla 403 app not installed'); return t; })());
      const tagIds = await careTagIds(env, ctx.merchant, get);
      const page = (n, extra) => get('/orders', { from_date: addDays(from, -1), to_date: addDays(to, 1), per_page: 30, page: n, ...extra });
      const plain = await page(1, {}), plainTotal = plain.pagination?.total ?? 0;
      /* طلبات الفريق = (أ) عليها وسم خدمة العملاء، أو (ب) أُنشئت من لوحة التحكم: الفريق وحده مخوّل بإنشاء الطلبات في سلة فبعضهم لا يضع الوسم */
      const sources = String(env.CARE_SOURCES ?? 'dashboard').split(',').map((x) => x.trim()).filter(Boolean);
      const queries = [...tagIds.map((t) => ({ kind: 'tag', extra: { 'tags[0]': t } })), ...sources.map((x) => ({ kind: 'src', extra: { 'source[0]': x } }))];
      const byId = new Map(), tagged = new Set();   // الطلب الذي يطابق أكثر من شرط يُحسب مرة واحدة
      for (const { kind, extra } of queries) {
        const first = await page(1, extra), tot = first.pagination?.total ?? 0;
        if (plainTotal > 30 && tot >= plainTotal) throw Object.assign(new Error('filter ignored'), { careErr: 'tag_filter_ignored' });   // لا نعرض كل الطلبات على أنها طلبات الفريق
        const pages = first.pagination?.totalPages || 1;
        if (pages > CARE_MAX_PAGES) throw Object.assign(new Error('too many orders'), { careErr: 'too_many' });
        const rest = pages > 1 ? await pool(Array.from({ length: pages - 1 }, (_, k) => k + 2), 8, (n) => page(n, extra)) : [];
        for (const o of [first, ...rest].flatMap((j) => j.data || [])) { byId.set(o.id, o); if (kind === 'tag') tagged.add(o.id); }
      }
      const batches = [{ data: [...byId.values()] }];
      const days = {}, status = {}, pay = {}, names = {}, list = [];
      let valid = 0, revenue = 0, canceled = 0, canceledValue = 0, unpaid = 0, all = 0, taggedN = 0;
      for (const o of batches.flatMap((j) => j.data || [])) {
        const day = String(o.date?.date || '').slice(0, 10);
        if (o.draft || day < from || day > to) continue;
        all++; if (tagged.has(o.id)) taggedN++;
        const st = mapStatus(o.status?.slug), total = Number(o.total?.amount) || 0;
        status[st] = (status[st] || 0) + 1;
        const nm = String(o.status?.customized?.name || o.status?.name || '—'); names[nm] = (names[nm] || 0) + 1;   // أسماء الحالات كما في سلة
        if (wantList) list.push([String(o.date.date).slice(0, 16), o.reference_id ?? o.id, nm, total, o.payment_method || '', tagged.has(o.id) ? 'نعم' : 'لا']);
        if (st === 'canceled') { canceled++; canceledValue += total; continue; }
        if (st === 'unpaid' || st === 'refunded') { if (st === 'unpaid') unpaid++; continue; }
        valid++; revenue += total;
        const d = days[day] || (days[day] = [0, 0]); d[0]++; d[1] += total;
        const pm = o.payment_method || 'other'; const p = pay[pm] || (pay[pm] = [0, 0]); p[0]++; p[1] += total;
      }
      await ensureSchema(env.DB);
      const totals = await rangeTotals(env.DB, ctx.merchant, from, to);
      const r2 = (n) => Math.round(n * 100) / 100;
      list.sort((a, b) => (a[0] < b[0] ? -1 : 1));
      return JSON.stringify({ tags: tagIds, sources, taggedOrders: taggedN, untaggedOrders: all - taggedN, ...(wantList ? { rows: list } : {}), statusNames: Object.entries(names).sort((a, b) => b[1] - a[1]), orders: all, valid, revenue: r2(revenue), aov: valid ? r2(revenue / valid) : 0, canceled, canceledValue: r2(canceledValue), unpaid, status,
        series: Object.entries(days).sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, [n, v]]) => [d, n, r2(v)]),
        pay: Object.entries(pay).map(([k, [n, v]]) => ({ k, orders: n, total: r2(v) })).sort((a, b) => b.total - a.total),
        all: totals, shareOrders: totals.orders ? r2(valid / totals.orders * 100) : 0, shareRevenue: totals.revenue ? r2(revenue / totals.revenue * 100) : 0 });
    });
    return new Response(text, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch (e) {
    if (e.careErr) return json({ error: e.careErr });
    throw e;
  }
}

/* ---------- /api/chat-stats: أرقام «المساعد الذكي» من خدمة ibrand-search (GET /report/chat، نفس REPORT_KEY) ----------
   أرقام فقط بلا نصوص محادثات (اللوحة تُشارَك بروابط). نُمرّر الأرقام فقط ونُسطّح الحقول المتداخلة، فلا يصل أي نص حرّ من الخدمة للصفحة. */
const flatNums = (o, pre = '', depth = 0, out = {}) => {
  if (!o || typeof o !== 'object' || Array.isArray(o) || depth > 2) return out;
  for (const [k, v] of Object.entries(o)) {
    const key = (pre ? pre + '_' : '') + String(k).replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);
    if (!key) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) flatNums(v, key, depth + 1, out);
  }
  return out;
};
async function handleChatStats(req, env) {
  const ctx = await dataContext(req, env);
  if (ctx.res) return ctx.res;
  if (!env.REPORT_KEY) return json({ error: 'not_configured' });
  try {
    const hit = memoStore.get('chatstats');
    if (hit && hit.exp > Date.now()) return new Response(hit.v, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    const init = { headers: { 'x-report-key': env.REPORT_KEY } };
    const base = (env.SEARCH_URL || SEARCH_DEFAULT_URL).replace(/\/report\/data$/, '');
    const r = env.SEARCH ? await env.SEARCH.fetch('https://search.internal/report/chat', init) : await fetch(base + '/report/chat', init);
    if (r.status === 401) return json({ error: 'bad_key' });
    if (r.status === 503) return json({ error: 'disabled' });
    if (r.status === 404) return json({ error: 'not_ready' });
    if (!r.ok) return json({ error: 'unreachable', status: r.status });
    const d = await r.json();
    const daily = (Array.isArray(d.daily) ? d.daily : []).slice(-366).map((x) => ({ day: String(x?.day ?? x?.date ?? '').slice(0, 10), ...flatNums(x) })).filter((x) => DATE_RE.test(x.day));
    const text = JSON.stringify({ generated_at: Number(d.generated_at) || 0, totals: flatNums(d.totals), rates: flatNums(d.rates_percent), daily });
    if (memoStore.size > 120) memoStore.clear();
    memoStore.set('chatstats', { v: text, exp: Date.now() + SEARCH_CACHE_MS });
    return new Response(text, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch (e) { return json({ error: 'unreachable' }); }
}

/* ---------- /api/recent: آخر 30 طلباً مباشرة (للجدول ونافذة التفاصيل) ---------- */
async function handleRecent(req, env) {
  const ctx = await authContext(req, env);
  if (ctx.res) return ctx.res;
  const body = await memo(`recent:${ctx.merchant}`, 30e3, async () => {
    await ensureSchema(env.DB);
    const j = await ctx.get('/orders', { per_page: 30, page: 1, sort_by: 'created_at-desc' });
    const map = await priceMap(env.DB, ctx.merchant, env.TOKENS);
    const orders = (j.data || []).map(normalizeOrder).filter((o) => !o.draft && o.status !== 'unpaid');
    orders.forEach((o) => priceLines(o, map));
    return { orders };
  });
  return json(body);
}

/* ---------- /api/inventory: من جدول D1 الذي تملؤه المزامنة ---------- */
async function handleInventory(req, env) {
  const ctx = await dataContext(req, env);
  if (ctx.res) return ctx.res;
  await ensureSchema(env.DB);
  const state = await getMeta(env.DB, ctx.merchant, 'state', {});
  return json({ items: await readInventory(env.DB, ctx.merchant), complete: !!state.invDoneOnce, updatedAt: state.invUpdatedAt || 0 });
}

/* ---------- /api/shipments: آخر 7 أيام دائماً (حجم الشحنات كحجم الطلبات) ---------- */
const SHIPMENT_DAYS = 7, SHIPMENT_MAX_PAGES = 40;
async function handleShipments(req, env) {
  const ctx = await authContext(req, env);
  if (ctx.res) return ctx.res;
  const to = riyadhDay(Date.now()), from = addDays(to, -(SHIPMENT_DAYS - 1));
  const body = await memo(`ship:${ctx.merchant}:${to}`, 300e3, async () => {
    const shipments = [];
    let truncated = false;
    // [VERIFY] أقصى per_page لهذه النقطة غير مذكور؛ نستخدم 30 كما في الطلبات
    for (let page = 1; ; page++) {
      if (page > SHIPMENT_MAX_PAGES) { truncated = true; break; }
      const j = await ctx.get('/shipments', { from_date: from, to_date: to, per_page: 30, page });
      (j.data || []).forEach((s) => shipments.push(normalizeShipment(s)));
      if (page >= (j.pagination?.totalPages ?? 1)) break;
    }
    return { shipments, truncated, days: SHIPMENT_DAYS };
  });
  return json(body);
}

/* ---------- /api/coupons ---------- */
async function handleCoupons(req, env) {
  const ctx = await authContext(req, env);
  if (ctx.res) return ctx.res;
  const body = await memo(`coupons:${ctx.merchant}`, 300e3, async () => {
    const coupons = [];
    for (let page = 1; page <= 30; page++) {
      const j = await ctx.get('/coupons', { page });
      (j.data || []).forEach((c) => { if (c.status !== 'deleted') coupons.push(normalizeCoupon(c)); });
      if (page >= (j.pagination?.totalPages ?? 1)) break;
    }
    return { coupons };
  });
  return json(body);
}

/* ---------- /api/customers: إجمالي المسجلين + المسجلون في فترة (صلاحية customers.read) ---------- */
async function handleCustomers(req, env) {
  const ctx = await dataContext(req, env);
  if (ctx.res) return ctx.res;
  const q = new URL(req.url).searchParams;
  if (!validRange(q)) return json({ error: 'bad range' }, 400);
  const from = q.get('from'), to = q.get('to');
  // واجهة /customers في سلة بلا إجمالي (ترقيم cursor)، فالعملاء يُحسبون من الطلبات المحمّلة في D1
  await ensureSchema(env.DB);
  // أرقام العملاء لا تحتاج لحظية: 10 دقائق للفترة، و6 ساعات للعدد الكلي (يقرأ كل الجدول)
  const body = await memo(`cust:${ctx.merchant}:${from}:${to}`, to < riyadhDay(Date.now()) ? 3 * 3600e3 : 30 * 60e3, async () => {
    const state = await getMeta(env.DB, ctx.merchant, 'state', {});
    const total = await memo(`custtotal:${ctx.merchant}`, 6 * 3600e3, () => customerTotal(env.DB, ctx.merchant));
    return { ...(await customerStats(env.DB, ctx.merchant, from, to)), total, backfillDone: !!state.backfillDone, error: state.custError || '' };
  });
  return json(body);
}

/* ---------- /api/competitors: مراقبة أسعار المنافسين (القراءة لتوكن سلة أو رابط المشاركة؛ التعديل لتوكن سلة فقط) ---------- */
const COMP_PER_RUN = 15, COMP_CRON = '*/5 * * * *';
const ourPriceMap = (env, merchant) => memo(`ourprice:${merchant}`, 600e3, async () => {
  const rows = await catalogBlob(env.TOKENS, env.DB, merchant), vat = 1 + (Number(env.VAT_RATE) || 15) / 100;   // سعر المنافس يشمل الضريبة؛ فنقارن بسعرنا شاملاً الضريبة للمنتجات الخاضعة لها
  return new Map(rows.map((r) => [String(r.name).trim().toLowerCase(), r.taxable !== 0 ? Math.round(r.price * vat * 100) / 100 : r.price]));
});
const startOfRiyadhDay = (now) => Date.parse(riyadhDay(now) + 'T00:00:00+03:00');
async function checkComp(env, merchant, id, now = Date.now()) {
  const row = await compOne(env.DB, merchant, id);
  if (!row) return { err: 'غير موجود' };
  const res = await checkCompetitorUrl(row.url);
  await compSave(env.DB, merchant, id, res, now, riyadhDay(now));
  return res;
}
// باركود المنتج (sku في سلة) ورابطه الإنجليزي عندنا، للمطابقة مع المنافسين
async function ourInfo(get, name) {
  try {
    const j = await get('/products', { keyword: name, per_page: 5, format: 'light' });
    const rows = j.data || [], n = normText(name);
    const p = rows.find((x) => normText(x.name) === n) || rows.find((x) => matchScore(name, x.name) >= 0.9);
    if (!p) return {};
    const code = [p.sku, p.gtin, p.mpn].map((v) => String(v || '').replace(/\D/g, '')).find((d) => d.length >= 8 && d.length <= 14) || '';
    const slug = /^[a-z0-9-]{6,}$/i.test(String(p.metadata?.url || '')) ? String(p.metadata.url).toLowerCase() : '';
    return { barcode: code, slug };
  } catch (e) { return {}; }
}
const COMP_TOP = 100, COMP_KEEP = 0.6;
// أفضل مرشّح لكل منافس يُضاف للمراقبة: الباركود (مُتحقَّق منه تلقائياً) أو الاسم من 60% (غير متحقق منه وتظهر نسبته ليراجعه المستخدم)
async function addSuggestions(env, merchant, product, suggestions, existing, rivals = null, keep = COMP_KEEP) {
  const best = new Map();
  for (const x of suggestions) if ((x.matchby === 'barcode' || (x.score >= keep && !(rivals && rivalOf(product, x.title, rivals)))) && !existing.has(product + '|' + x.competitor) && (!best.has(x.competitor) || x.score > best.get(x.competitor).score)) best.set(x.competitor, x);
  let n = 0;
  for (const x of best.values()) {
    const id = await compUpsert(env.DB, merchant, { product, competitor: x.competitor, url: x.url, matchby: x.matchby, score: x.score, verified: x.matchby === 'barcode' ? 1 : 0, code: x.code || '' });
    await compSave(env.DB, merchant, id, { ok: true, price: x.price, currency: 'SAR', avail: x.avail, title: x.title }, Date.now(), riyadhDay(Date.now()));
    existing.add(product + '|' + x.competitor); n++;
  }
  return n;
}
/* مهمة البحث عن المنافسين تعمل على الخادم (meta comp_job): تستمر ولو أغلق المستخدم الصفحة، ويدفعها الجدول المجدول كل 5 دقائق والمتصفح (إن كان مفتوحاً) بدفعات */
const ownRivals = async (env, merchant) => makeRivalIndex((await catalogBlob(env.TOKENS, env.DB, merchant)).map((r) => r.name));   // أسماء منتجاتنا لاكتشاف المتشابهات
const JOB = 'comp_job';
const jobView = (j) => (j ? { running: !j.done, total: j.queue.length, idx: j.idx, added: j.added, missed: j.missed, mode: j.mode, only: j.only || '', started: j.started } : { running: false, total: 0, idx: 0, added: 0, missed: 0, mode: '', started: 0 });
async function startJob(env, merchant, n, mode, now = Date.now(), only = '') {
  const cur = await getMeta(env.DB, merchant, JOB, null);
  if (cur && !cur.done) return cur;                                                   // مهمة جارية: لا نبدأ ثانية
  const today = riyadhDay(now), rows = await rangeRows(env.DB, merchant, addDays(today, -30), today);
  let queue = sumDays(rows, true, null).products.slice(0, Math.min(only ? 2000 : 500, Math.max(1, n))).map((p) => p.name);
  const want = Math.min(only ? 2000 : 500, Math.max(1, n));
  if (queue.length < want) {                                                         // مبيعات آخر 30 يوماً أقل من المطلوب: نكمل من كتالوجنا (بعد الأكثر مبيعاً)
    const have = new Set(queue);
    for (const r of await catalogBlob(env.TOKENS, env.DB, merchant)) { if (queue.length >= want) break; if (r.name && !have.has(r.name)) { have.add(r.name); queue.push(r.name); } }
  }
  const job = { only, queue, idx: 0, added: 0, missed: 0, mode, started: now, done: !queue.length };
  await setMeta(env.DB, merchant, JOB, job);
  return job;
}
async function jobStep(env, merchant, batch) {
  let job = await getMeta(env.DB, merchant, JOB, null);
  if (!job || job.done) return job;
  const take = job.queue.slice(job.idx, job.idx + batch);
  job.idx += take.length; if (job.idx >= job.queue.length) job.done = true;
  await setMeta(env.DB, merchant, JOB, job);                                           // نحجز الدفعة قبل معالجتها كي لا يكررها تشغيل آخر
  const tokens = await loadTokens(env, merchant); if (!tokens) return job;
  const get = makeClient(env, merchant, tokens), existing = new Set((await compList(env.DB, merchant)).map((r) => r.product + '|' + r.competitor)), rivals = await ownRivals(env, merchant);
  let added = 0, missed = 0;
  for (const name of take) {
    try { const n = await addSuggestions(env, merchant, name, await suggestFor(name, { info: await ourInfo(get, name), kv: env.TOKENS, ...(job.only ? { sites: [job.only] } : {}) }), existing, rivals, job.only ? 0.5 : COMP_KEEP); added += n; if (!n) missed++; } catch (e) { missed++; }
  }
  job = (await getMeta(env.DB, merchant, JOB, null)) || job; job.added += added; job.missed += missed;
  await setMeta(env.DB, merchant, JOB, job);
  return job;
}
// كل أسبوع تبدأ مهمة تلقائية لأعلى المنتجات مبيعاً؛ وكل تشغيل مجدول يعالج دفعة من أي مهمة جارية
async function compWeekly(env, merchant, now) {
  const at = await getMeta(env.DB, merchant, 'comp_weekly_at', 0), cur = await getMeta(env.DB, merchant, JOB, null);
  if ((!cur || cur.done) && now - at >= 7 * 864e5) { await startJob(env, merchant, Number(env.COMP_TOP) || COMP_TOP, 'weekly', now); await setMeta(env.DB, merchant, 'comp_weekly_at', now); }
  const j = await getMeta(env.DB, merchant, JOB, null);
  if (j && !j.done) await jobStep(env, merchant, Number(env.COMP_BATCH) || 8);
}
async function handleCompetitors(req, env) {
  const u = new URL(req.url), sub = u.pathname.slice('/api/competitors'.length);
  // القراءة (GET) متاحة لرابط المشاركة (الإدارة تشاهد الروابط والمقارنات فقط)؛ الإضافة والبحث والفحص والتحقق والحذف بتوكن سلة فقط
  const merchant = (await merchantFromEmbeddedToken(req, env)) || (req.method === 'GET' && !sub ? (await shareFromRequest(req, env))?.merchant : null);
  if (!merchant) return json({ error: 'unauthorized' }, 401);
  await ensureSchema(env.DB);
  if (req.method === 'GET' && !sub) {
    const [rows, ours] = await Promise.all([compList(env.DB, merchant), ourPriceMap(env, merchant)]);
    const items = rows.map((r) => { const our = ours.get(String(r.product).trim().toLowerCase()) ?? null; return { ...r, ourPrice: our, diffPct: our && r.price ? Math.round((our / r.price - 1) * 1000) / 10 : null }; });
    return json({ items });
  }
  if (req.method === 'GET' && sub === '/job') return json(jobView(await getMeta(env.DB, merchant, JOB, null)));
  if (req.method === 'DELETE' && !sub) { await compDelete(env.DB, merchant, Number(u.searchParams.get('id')) || 0); return json({ ok: true }); }
  if (req.method !== 'POST') return json({ error: 'not found' }, 404);
  const b = await req.json().catch(() => ({}));
  if (sub === '/clean') {   // تفحص المطابقات الاسمية غير المتحقق منها: ما تبيّن أنه يطابق منتجاً آخر عندنا أفضل، أو هبطت درجته تحت 50% بالقواعد الحالية (مثل نان ديو ≠ نان)، يُستبعد
    const rv = await ownRivals(env, merchant); let n = 0;
    for (const r of await compList(env.DB, merchant)) if (!r.ignored && !r.verified && r.matchby !== 'barcode' && r.title && (rivalOf(r.product, r.title, rv) || matchScore(r.product, r.title) < 0.5)) { await compIgnore(env.DB, merchant, r.id, true); n++; }
    return json({ ignored: n });
  }
  if (sub === '/job') return json(jobView(b.restart ? (await setMeta(env.DB, merchant, JOB, null), await startJob(env, merchant, Number(b.n) || COMP_TOP, 'manual', Date.now(), String(b.only || ''))) : await startJob(env, merchant, Number(b.n) || COMP_TOP, 'manual', Date.now(), String(b.only || ''))));
  if (sub === '/job/step') return json(jobView(await jobStep(env, merchant, 3)));
  if (sub === '/verify') { await compVerify(env.DB, merchant, Number(b.id) || 0, !!b.on); return json({ ok: true }); }
  if (sub === '/ignore') { await compIgnore(env.DB, merchant, Number(b.id) || 0, !!b.ignored); return json({ ok: true }); }
  if (sub === '/check') return json(await checkComp(env, merchant, Number(b.id) || 0));
  if (sub === '/suggest') {   // مرشّحون من مواقع المنافسين (بالباركود ثم الاسم)
    const name = String(b.product || '').trim().slice(0, 200), tokens = await loadTokens(env, merchant);
    const info = name && tokens ? await ourInfo(makeClient(env, merchant, tokens), name) : {};
    const rv = await ownRivals(env, merchant), sg = name ? await suggestFor(name, { info, kv: env.TOKENS }) : [];
    return json({ suggestions: sg.filter((x) => x.matchby === 'barcode' || !rivalOf(name, x.title, rv)), barcode: info.barcode || '' });
  }
  if (sub !== '') return json({ error: 'not found' }, 404);
  const lines = (Array.isArray(b.lines) ? b.lines : []).slice(0, 300), added = [], rejected = [];
  for (const l of lines) {
    const product = String(l?.product || '').trim().slice(0, 200), competitor = String(l?.competitor || '').trim().slice(0, 60), url = validCompetitorUrl(l?.url || '');
    if (!product || !competitor) rejected.push({ product, reason: 'المنتج أو المنافس ناقص' });
    else if (!url) rejected.push({ product, reason: 'الرابط غير صالح (يجب أن يكون https لموقع المنافس)' });
    else {
      const mb = l?.matchby === 'barcode' ? 'barcode' : l?.matchby === 'name' ? 'name' : '', sc = Number(l?.score);
      const id = await compUpsert(env.DB, merchant, { product, competitor, url, matchby: mb, score: Number.isFinite(sc) ? sc : null, verified: mb === 'barcode' ? 1 : 0, code: String(l?.code || '').replace(/\D/g, '').slice(0, 14) });
      const pr = Number(l?.price);
      if (Number.isFinite(pr) && pr > 0 && pr < 1e6) await compSave(env.DB, merchant, id, { ok: true, price: pr, currency: 'SAR', avail: l.avail === 1 || l.avail === 0 ? l.avail : null, title: String(l.title || '').slice(0, 200) }, Date.now(), riyadhDay(Date.now()));   // اقتراح مُعتمد: سعره قُرئ للتو، فلا ننتظر الجدول
      else added.push({ id, product, competitor });
      if (Number.isFinite(pr) && pr > 0 && pr < 1e6) added.push({ id, product, competitor, done: true });
    }
  }
  const results = [];
  if (b.check !== false && added.length && added.length <= 5) for (const a of added.filter((x) => !x.done)) results.push({ id: a.id, ...(await checkComp(env, merchant, a.id)) });   // القليل نفحصه فوراً؛ والباقي يفحصه الجدول المجدول
  return json({ added: added.length, rejected, results });
}
export async function compCron(env, now = Date.now()) {
  const { keys } = await env.TOKENS.list({ prefix: 'merchant:' });
  let n = 0;
  for (const k of keys) {
    const merchant = k.name.slice('merchant:'.length);
    await ensureSchema(env.DB);
    const due = await compDue(env.DB, merchant, startOfRiyadhDay(now), Number(env.COMP_PER_RUN) || COMP_PER_RUN);   // ما لم يُفحص اليوم بعد
    await pool(due, 5, (d) => checkComp(env, merchant, d.id, now));
    n += due.length;
    try { await compWeekly(env, merchant, now); } catch (e) { /* لا نُفشل فحص الأسعار */ }
  }
  return n;
}

/* ---------- Cron: المزامنة لكل تاجر مثبّت ---------- */
export async function syncAll(env, now = Date.now()) {
  const { keys } = await env.TOKENS.list({ prefix: 'merchant:' });
  const out = [];
  for (const k of keys) {
    const merchant = k.name.slice('merchant:'.length);
    const tokens = await loadTokens(env, merchant);
    if (!tokens) continue;
    try { out.push([merchant, await syncMerchant(env, merchant, { get: makeClient(env, merchant, tokens) }, now)]); }
    catch (e) { out.push([merchant, { error: String(e.message || e) }]); }
  }
  return out;
}

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    try {
      if (pathname === '/webhook' && req.method === 'POST') return await handleWebhook(req, env);
      if (pathname === '/api/summary' && req.method === 'GET') return await handleSummary(req, env);
      if (pathname === '/api/share' && ['GET', 'POST', 'DELETE'].includes(req.method)) return await handleShare(req, env);
      if (pathname === '/api/export.csv' && req.method === 'GET') return await handleExport(req, env);
      if (pathname === '/api/months' && req.method === 'GET') return await handleMonths(req, env);
      if (pathname === '/api/search-gaps' && req.method === 'GET') return await handleSearchGaps(req, env);
      if (pathname === '/api/care-orders' && req.method === 'GET') return await handleCare(req, env);
      if (pathname === '/api/chat-stats' && req.method === 'GET') return await handleChatStats(req, env);
      if (pathname.startsWith('/api/competitors')) return await handleCompetitors(req, env);
      if (pathname === '/api/basket' && req.method === 'GET') return await handleBasket(req, env);
      if (pathname === '/api/recent' && req.method === 'GET') return await handleRecent(req, env);
      if (pathname === '/api/inventory' && req.method === 'GET') return await handleInventory(req, env);
      if (pathname === '/api/coupons' && req.method === 'GET') return await handleCoupons(req, env);
      if (pathname === '/api/shipments' && req.method === 'GET') return await handleShipments(req, env);
      if (pathname === '/api/customers' && req.method === 'GET') return await handleCustomers(req, env);
    } catch (e) {
      const msg = String(e.message || e);
      // صلاحية ناقصة في التطبيق: رد واضح بدل 502 (الواجهة تعرض «فعّل الصلاحية»)
      if (/^salla (401|403)\b/.test(msg)) return json({ error: 'forbidden', message: msg }, 403);
      return json({ error: 'server_error', message: msg }, 502);
    }
    return env.ASSETS.fetch(req);
  },
  async scheduled(event, env, ctx) {
    // جدولان منفصلان (تشغيلان مستقلان بميزانيتهما من النداءات الفرعية): المزامنة كل دقيقة، وفحص أسعار المنافسين كل 5 دقائق
    ctx.waitUntil(event.cron === COMP_CRON ? compCron(env, event.scheduledTime) : syncAll(env, event.scheduledTime));
  }
};
