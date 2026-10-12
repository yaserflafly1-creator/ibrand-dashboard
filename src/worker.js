import { normalizeOrder, normalizeItems } from './salla.js';

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
  // [VERIFY] اسم ترويسة التوقيع وطريقته (Signature strategy) في وثائق Webhooks
  const sig = req.headers.get('x-salla-signature') || '';
  if (!env.SALLA_WEBHOOK_SECRET || !safeEqual(sig, await hmacHex(env.SALLA_WEBHOOK_SECRET, raw))) {
    return json({ error: 'bad signature' }, 401);
  }
  const evt = JSON.parse(raw);
  const merchant = String(evt.merchant ?? evt.data?.merchant ?? '');
  if (!merchant) return json({ ok: true });

  if (evt.event === 'app.store.authorize') {
    // [VERIFY] data.access_token / refresh_token / expires (Easy Mode)
    const d = evt.data || {};
    await saveTokens(env, merchant, { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Number(d.expires) * 1000 || 0 });
  } else if (evt.event === 'app.uninstalled') {
    await env.TOKENS.delete(`merchant:${merchant}`);
  }
  return json({ ok: true });
}

const saveTokens = (env, merchant, t) => env.TOKENS.put(`merchant:${merchant}`, JSON.stringify(t));
const loadTokens = async (env, merchant) => JSON.parse((await env.TOKENS.get(`merchant:${merchant}`)) || 'null');

/* ---------- هوية التاجر من توكن التطبيق المضمَّن ---------- */
async function merchantFromEmbeddedToken(req, env) {
  const token = new URL(req.url).searchParams.get('token') || (req.headers.get('authorization') || '').replace(/^Bearer /i, '');
  if (!token) return null;
  // [VERIFY] نقطة التحقق (introspect) وشكل الاستجابة في وثائق Embedded Apps
  const r = await fetch(env.SALLA_INTROSPECT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token })
  });
  if (!r.ok) return null;
  const j = await r.json();
  const id = j?.data?.merchant_id ?? j?.merchant_id ?? j?.data?.merchant;
  return id ? String(id) : null;
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
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function handleOrders(req, env) {
  const merchant = await merchantFromEmbeddedToken(req, env);
  if (!merchant) return json({ error: 'unauthorized' }, 401);
  const tokens = await loadTokens(env, merchant);
  if (!tokens) return json({ error: 'app not installed' }, 403);

  const q = new URL(req.url).searchParams;
  const from = q.get('from'), to = q.get('to');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) return json({ error: 'bad range' }, 400);

  const get = makeClient(env, merchant, tokens);
  const orders = [];
  // [VERIFY] أسماء معاملات التصفية from_date / to_date / per_page / page وشكل pagination
  for (let page = 1; page <= 60; page++) {
    const j = await get('/orders', { from_date: from, to_date: to, per_page: 65, page });
    (j.data || []).forEach((o) => orders.push(normalizeOrder(o)));
    const p = j.pagination;
    if (!p || page >= (p.totalPages ?? p.total_pages ?? 1)) break;
  }

  // تفاصيل المنتجات للطلبات الأحدث فقط (حد لحماية حدود الـ subrequests)
  const cap = Math.min(Number(env.MAX_ORDER_DETAILS) || 200, 900);
  const need = orders.filter((o) => o.status === 'completed' || o.status === 'shipping')
    .sort((a, b) => b.ts - a.ts).slice(0, cap);
  await pool(need, 8, async (o) => {
    try { o.lines = normalizeItems((await get(`/orders/${o.sallaId}`)).data); } catch { /* نتجاهل فشل طلب واحد */ }
  });

  return json({ orders, currency: orders[0]?.currency || 'SAR', detailedOrders: need.length });
}

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    try {
      if (pathname === '/webhook' && req.method === 'POST') return await handleWebhook(req, env);
      if (pathname === '/api/orders' && req.method === 'GET') return await handleOrders(req, env);
    } catch (e) {
      return json({ error: 'server_error', message: String(e.message || e) }, 502);
    }
    return env.ASSETS.fetch(req);
  }
};
