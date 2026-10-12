import { normalizeOrder, buildPriceMap, applyCatalog, normalizeInventoryItem, normalizeCoupon, normalizeShipment } from './salla.js';

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
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || new URL(req.url).searchParams.get('token');
  if (!token || !env.SALLA_APP_ID) return null;
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
  if (d.exp && Date.parse(d.exp) < Date.now()) return null;                                  // منتهي
  // [VERIFY] نفترض أن merchant_id هو نفسه حقل merchant في الـ webhooks (نؤكده بتجربة فعلية)
  return String(id);
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
    if (!r.ok) throw new Error(`salla ${r.status} ${path}`);
    return r.json();
  };
}

/* ---------- /api/orders ---------- */
const PER_PAGE = 30;      // الحد الأقصى المسموح (وثيقة List Orders)
const MAX_PAGES = 300;    // سقف أمان لعدد النداءات
const CACHE_TTL_LIVE = 60;    // ثوانٍ، للفترات التي تشمل اليوم
const CACHE_TTL_PAST = 600;   // للفترات المنتهية
const CATALOG_TTL = 3600;
const todayRiyadh = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);

// كتالوج المنتجات (format=light) لأسعار «الأكثر مبيعاً». يحتاج صلاحية products.read
async function loadCatalog(env, merchant, get) {
  const key = `catalog:${merchant}`;
  const hit = await env.TOKENS.get(key);
  if (hit) return JSON.parse(hit);
  const products = [];
  for (let page = 1; page <= 60; page++) {
    const j = await get('/products', { format: 'light', per_page: 30, page });
    (j.data || []).forEach((p) => products.push({ name: p.name, price: p.price, sale_price: p.sale_price, thumbnail: p.thumbnail, image: p.image }));
    if (page >= (j.pagination?.totalPages ?? 1)) break;
  }
  await env.TOKENS.put(key, JSON.stringify(products), { expirationTtl: CATALOG_TTL });
  return products;
}

// تحقق الهوية + تجهيز عميل سلة؛ يرجع { res } عند الفشل أو { merchant, get } عند النجاح
async function authContext(req, env) {
  const merchant = await merchantFromEmbeddedToken(req, env);
  if (!merchant) return { res: json({ error: 'unauthorized' }, 401) };
  const tokens = await loadTokens(env, merchant);
  if (!tokens) return { res: json({ error: 'app not installed' }, 403) };
  return { merchant, get: makeClient(env, merchant, tokens) };
}

const cachedJson = (body) => new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

/* ---------- /api/inventory ---------- */
async function handleInventory(req, env) {
  const ctx = await authContext(req, env);
  if (ctx.res) return ctx.res;
  const key = `inventory:${ctx.merchant}`;
  const hit = await env.TOKENS.get(key);
  if (hit) return cachedJson(hit);
  const items = [];
  // الوثيقة لا تذكر per_page لهذه النقطة، فنمرّ على كل الصفحات بالتسلسل
  for (let page = 1; page <= 100; page++) {
    const j = await ctx.get('/products/quantities', { page });
    (j.data || []).forEach((p) => items.push(normalizeInventoryItem(p)));
    if (page >= (j.pagination?.totalPages ?? 1)) break;
  }
  const body = JSON.stringify({ items });
  await env.TOKENS.put(key, body, { expirationTtl: 120 });
  return cachedJson(body);
}

/* ---------- /api/shipments ---------- */
async function handleShipments(req, env) {
  const ctx = await authContext(req, env);
  if (ctx.res) return ctx.res;
  const q = new URL(req.url).searchParams;
  const from = q.get('from'), to = q.get('to');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) return json({ error: 'bad range' }, 400);
  const key = `shipments:${ctx.merchant}:${from}:${to}`;
  const hit = await env.TOKENS.get(key);
  if (hit) return cachedJson(hit);
  const shipments = [];
  let truncated = false;
  // [VERIFY] أقصى per_page لهذه النقطة غير مذكور؛ نستخدم 30 كما في الطلبات
  for (let page = 1; ; page++) {
    if (page > 100) { truncated = true; break; }
    const j = await ctx.get('/shipments', { from_date: from, to_date: to, per_page: 30, page });
    (j.data || []).forEach((s) => shipments.push(normalizeShipment(s)));
    if (page >= (j.pagination?.totalPages ?? 1)) break;
  }
  const body = JSON.stringify({ shipments, truncated });
  if (!truncated) await env.TOKENS.put(key, body, { expirationTtl: to >= todayRiyadh() ? CACHE_TTL_LIVE : CACHE_TTL_PAST });
  return cachedJson(body);
}

/* ---------- /api/coupons ---------- */
async function handleCoupons(req, env) {
  const ctx = await authContext(req, env);
  if (ctx.res) return ctx.res;
  const key = `coupons:${ctx.merchant}`;
  const hit = await env.TOKENS.get(key);
  if (hit) return cachedJson(hit);
  const coupons = [];
  for (let page = 1; page <= 50; page++) {
    const j = await ctx.get('/coupons', { page });
    (j.data || []).forEach((c) => { if (c.status !== 'deleted') coupons.push(normalizeCoupon(c)); });
    if (page >= (j.pagination?.totalPages ?? 1)) break;
  }
  const body = JSON.stringify({ coupons });
  await env.TOKENS.put(key, body, { expirationTtl: 120 });
  return cachedJson(body);
}

/* ---------- /api/customers: إجمالي المسجلين + المسجلون في فترة (صلاحية customers.read) ---------- */
async function handleCustomers(req, env) {
  const ctx = await authContext(req, env);
  if (ctx.res) return ctx.res;
  const q = new URL(req.url).searchParams;
  const from = q.get('from'), to = q.get('to');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) return json({ error: 'bad range' }, 400);
  const key = `customers:${ctx.merchant}:${from}:${to}`;
  const hit = await env.TOKENS.get(key);
  if (hit) return cachedJson(hit);
  // [VERIFY] قسم pagination في هذه النقطة موصوف cursor-based في الوثيقة؛ نقرأ total إن وُجد وإلا null
  const [all, ranged] = await Promise.all([
    ctx.get('/customers', { page: 1 }),
    ctx.get('/customers', { page: 1, date_from: from, date_to: to })
  ]);
  const body = JSON.stringify({ total: all.pagination?.total ?? null, inRange: ranged.pagination?.total ?? null });
  await env.TOKENS.put(key, body, { expirationTtl: 120 });
  return cachedJson(body);
}

async function handleOrders(req, env) {
  const ctx = await authContext(req, env);
  if (ctx.res) return ctx.res;
  const { merchant, get } = ctx;

  const q = new URL(req.url).searchParams;
  const from = q.get('from'), to = q.get('to');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) return json({ error: 'bad range' }, 400);

  const cacheKey = `orders:${merchant}:${from}:${to}`;
  const cached = await env.TOKENS.get(cacheKey);
  if (cached) return new Response(cached, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

  const orders = [];
  let truncated = false;
  // الصفحات تُجلب بالتسلسل ولا تُتخطى (قيد من سلة)، والتصفية بالتاريخ تقلل العدد
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) { truncated = true; break; }
    const j = await get('/orders', { from_date: from, to_date: to, per_page: PER_PAGE, page });
    (j.data || []).forEach((o) => { const n = normalizeOrder(o); if (!n.draft && n.status !== 'unpaid') orders.push(n); });
    if (page >= (j.pagination?.totalPages ?? 1)) break;
  }

  let pricesEstimated = true;
  try {
    const { matched, total } = applyCatalog(orders, buildPriceMap(await loadCatalog(env, merchant, get)));
    pricesEstimated = matched < total;
  } catch { /* بدون products.read نبقى على تقدير السعر */ }

  const body = JSON.stringify({ orders, currency: orders[0]?.currency || 'SAR', truncated, pricesEstimated });
  if (!truncated) await env.TOKENS.put(cacheKey, body, { expirationTtl: to >= todayRiyadh() ? CACHE_TTL_LIVE : CACHE_TTL_PAST });
  return new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    try {
      if (pathname === '/webhook' && req.method === 'POST') return await handleWebhook(req, env);
      if (pathname === '/api/orders' && req.method === 'GET') return await handleOrders(req, env);
      if (pathname === '/api/inventory' && req.method === 'GET') return await handleInventory(req, env);
      if (pathname === '/api/coupons' && req.method === 'GET') return await handleCoupons(req, env);
      if (pathname === '/api/shipments' && req.method === 'GET') return await handleShipments(req, env);
      if (pathname === '/api/customers' && req.method === 'GET') return await handleCustomers(req, env);
    } catch (e) {
      return json({ error: 'server_error', message: String(e.message || e) }, 502);
    }
    return env.ASSETS.fetch(req);
  }
};
