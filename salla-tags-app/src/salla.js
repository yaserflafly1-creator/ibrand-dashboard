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
const setTags = (merchantId, id, tags) => call(merchantId, 'PUT', `/products/${id}`, { tags });

const listProducts = (merchantId, page) => call(merchantId, 'GET', `/products?page=${page}&per_page=50`);

module.exports = { getProduct, setTags, listProducts };
