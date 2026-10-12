const store = require('./store');

const API = 'https://api.salla.dev/admin/v2';
const TOKEN_URL = 'https://accounts.salla.sa/oauth2/token';

async function refreshToken(merchantId) {
  const m = store.getMerchant(merchantId);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: m.refresh_token,
      client_id: process.env.SALLA_CLIENT_ID,
      client_secret: process.env.SALLA_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`فشل تجديد التوكن: ${res.status}`);
  const t = await res.json();
  // سلة تدوّر refresh_token: لازم نحفظ الجديد
  store.setMerchant(merchantId, {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Date.now() + t.expires_in * 1000,
  });
  return t.access_token;
}

async function call(merchantId, method, path, body, retried = false) {
  const m = store.getMerchant(merchantId);
  if (!m) throw new Error(`المتجر ${merchantId} غير مسجّل`);
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${m.access_token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !retried) {
    await refreshToken(merchantId);
    return call(merchantId, method, path, body, true);
  }
  if (!res.ok) throw new Error(`Salla ${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

const getProduct = (merchantId, id) => call(merchantId, 'GET', `/products/${id}`).then((r) => r.data);
const listProducts = (merchantId, page) => call(merchantId, 'GET', `/products?page=${page}&per_page=50`);

// وسوم سلة كيانات (id + name): نجلب الموجود وننشئ الناقص ثم نرسل المعرّفات.
// كاش بالذاكرة لكل متجر: اسم الوسم (lowercase) -> id
const tagCache = new Map();
const keyOf = (name) => name.trim().toLowerCase();

async function loadTags(merchantId) {
  const map = new Map();
  for (let page = 1; page <= 100; page++) {
    const r = await call(merchantId, 'GET', `/products/tags?page=${page}`);
    const before = map.size;
    for (const t of r.data || []) map.set(keyOf(t.name), t.id);
    if (!r.data?.length || map.size === before) break; // انتهت الصفحات أو تكررت
  }
  tagCache.set(merchantId, map);
  return map;
}

async function createTag(merchantId, name) {
  const qs = new URLSearchParams({ tag_name: name });
  const r = await call(merchantId, 'POST', `/products/tags?${qs}`);
  const d = Array.isArray(r.data) ? r.data[0] : r.data; // التوثيق يعرض الاستجابة ككائن أو مصفوفة
  return d.id;
}

async function ensureTagIds(merchantId, names) {
  const map = tagCache.get(merchantId) || (await loadTags(merchantId));
  const ids = [];
  for (const name of names) {
    const k = keyOf(name);
    if (!map.has(k)) {
      try {
        map.set(k, await createTag(merchantId, name));
      } catch (err) {
        console.error(`تعذّر إنشاء الوسم "${name}":`, err.message);
        continue;
      }
    }
    ids.push(map.get(k));
  }
  return ids;
}

async function setTags(merchantId, id, names) {
  const ids = await ensureTagIds(merchantId, names);
  try {
    return await call(merchantId, 'PUT', `/products/${id}`, { tags: ids });
  } catch (err) {
    // صفحة Update Product لم نتحقق منها: لو رفضت المعرّفات نجرّب الأسماء
    if (!/-> 4\d\d/.test(err.message)) throw err;
    console.warn('رفضت سلة معرّفات الوسوم، نجرّب الأسماء:', err.message);
    return call(merchantId, 'PUT', `/products/${id}`, { tags: names });
  }
}

module.exports = { getProduct, setTags, listProducts, ensureTagIds };
