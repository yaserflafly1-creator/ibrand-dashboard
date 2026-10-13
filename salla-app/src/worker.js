import { normalizeOrder, normalizeCoupon, normalizeShipment } from './salla.js';
import { sumDays, seriesOf } from './agg.js';
import { ensureSchema, getMeta, rangeRows, coverage, readInventory, campaignStats, customerStats } from './db.js';
import { syncMerchant, priceMap, priceLines, addDays, riyadhDay, CAMPAIGN_DAYS_DEFAULT } from './sync.js';

/* ذاكرة مؤقتة داخل الـ isolate: تخفف النداءات المتكررة دون استهلاك عمليات كتابة KV */
const memoStore = new Map();
async function memo(key, ttlMs, fn) {
  const hit = memoStore.get(key);
  if (hit && hit.exp > Date.now()) return hit.v;
  const v = await fn();
  if (memoStore.size > 500) memoStore.clear();
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
const SHARE_MAX_DAYS = 90, SHARE_ID_RE = /^[0-9a-f]{32}$/;
async function shareFromRequest(req, env) {
  const m = /^Share ([0-9a-f]{32})$/.exec(req.headers.get('authorization') || '');
  if (!m) return null;
  const raw = await env.TOKENS.get(`share:${m[1]}`);
  if (!raw) return null;
  const rec = JSON.parse(raw);
  return rec.exp > Date.now() ? rec : null;
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

  await ensureSchema(env.DB);
  const rows = await rangeRows(env.DB, ctx.merchant, prevFrom, to);
  const curRows = rows.filter((d) => d.day >= from), prevRows = rows.filter((d) => d.day < from);
  const state = await getMeta(env.DB, ctx.merchant, 'state', {});
  const cov = await coverage(env.DB, ctx.merchant);
  const campaigns = await campaignStats(env.DB, ctx.merchant, from, to);
  campaigns.since = addDays(riyadhDay(Date.now()), -(Number(env.CAMPAIGN_DAYS) || CAMPAIGN_DAYS_DEFAULT));
  return json({
    cur: sumDays(curRows), prev: sumDays(prevRows, false), series: seriesOf(curRows), campaigns,
    currency: state.currency || 'SAR',
    sync: { ...cov, backfillDone: !!state.backfillDone, inventoryOff: env.INVENTORY_SYNC === 'off', inventoryReady: !!state.invDoneOnce, lastRecent: state.lastRecent || 0, catalogReady: !!state.catDoneOnce,
      stage: (env.CATALOG_SYNC !== 'off' && !state.catDoneOnce) ? 'catalog' : state.resyncNext ? 'resync' : state.backfillDone ? 'done' : 'backfill',
      catPage: state.catPage || 1, resyncNext: state.resyncNext || null, backfillNext: state.backfillNext || null, lastRunAt: state.lastRunAt || 0, lastLog: state.lastLog || [], lastUsed: state.lastUsed || 0, error: state.lastError || (env.INVENTORY_SYNC === 'off' ? '' : state.invError) || state.catError || '' }
  });
}

/* ---------- /api/recent: آخر 30 طلباً مباشرة (للجدول ونافذة التفاصيل) ---------- */
async function handleRecent(req, env) {
  const ctx = await authContext(req, env);
  if (ctx.res) return ctx.res;
  const body = await memo(`recent:${ctx.merchant}`, 30e3, async () => {
    await ensureSchema(env.DB);
    const j = await ctx.get('/orders', { per_page: 30, page: 1, sort_by: 'created_at-desc' });
    const map = await priceMap(env.DB, ctx.merchant);
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
  return json(await customerStats(env.DB, ctx.merchant, from, to));
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
    ctx.waitUntil(syncAll(env, event.scheduledTime));
  }
};
