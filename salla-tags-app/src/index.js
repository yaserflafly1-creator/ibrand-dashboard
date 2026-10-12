const crypto = require('crypto');
const express = require('express');
const store = require('./store');
const salla = require('./salla');
const { generateTags, TAG_COUNT } = require('./tags');

const app = express();
// نحتاج الجسم الخام للتحقق من توقيع سلة
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

function validSignature(req) {
  const sig = req.get('x-salla-signature');
  if (!sig || !req.rawBody) return false;
  const expected = crypto.createHmac('sha256', process.env.SALLA_WEBHOOK_SECRET).update(req.rawBody).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const contentHash = (p) =>
  crypto.createHash('sha1').update(`${p.name}|${p.description || ''}|${(p.categories || []).map((c) => c.id)}`).digest('hex');

const inFlight = new Set();

async function processProduct(merchantId, productId) {
  const key = `${merchantId}:${productId}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    const product = await salla.getProduct(merchantId, productId);
    const hash = contentHash(product);
    // نتجاهل تعديلاتنا نحن (الوسوم فقط تغيّرت) ونتجنب حلقة webhook لا نهائية
    if (store.getProductHash(merchantId, productId) === hash && (product.tags || []).length >= TAG_COUNT) return;

    const tags = await generateTags(product);
    await salla.setTags(merchantId, productId, tags);
    store.setProductHash(merchantId, productId, hash);
    console.log(`✔ ${key}: ${tags.length} وسم`);
  } catch (err) {
    console.error(`✘ ${key}:`, err.message);
  } finally {
    inFlight.delete(key);
  }
}

app.post('/webhooks/salla', (req, res) => {
  if (!validSignature(req)) return res.sendStatus(401);
  res.sendStatus(200); // نرد بسرعة ونكمل بالخلفية

  const { event, merchant, data } = req.body;
  if (event === 'app.store.authorize') {
    // Easy Mode: سلة ترسل التوكنات هنا عند تثبيت التطبيق
    store.setMerchant(merchant, {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires ? data.expires * 1000 : undefined,
    });
    console.log(`تم تثبيت التطبيق للمتجر ${merchant}`);
  } else if (event === 'product.created' || event === 'product.updated') {
    processProduct(merchant, data.id);
  } else if (event === 'app.uninstalled') {
    store.setMerchant(merchant, { access_token: null, refresh_token: null });
  }
});

// معالجة كل المنتجات الحالية لمتجر (للتشغيل اليدوي): POST /admin/backfill/:merchantId
// محمية بالسر نفسه: Authorization: Bearer <SALLA_WEBHOOK_SECRET>
app.post('/admin/backfill/:merchantId', async (req, res) => {
  if (req.get('authorization') !== `Bearer ${process.env.SALLA_WEBHOOK_SECRET}`) return res.sendStatus(401);
  res.json({ started: true });
  const { merchantId } = req.params;
  for (let page = 1; ; page++) {
    const r = await salla.listProducts(merchantId, page).catch((e) => (console.error(e.message), null));
    if (!r || !r.data?.length) break;
    for (const p of r.data) await processProduct(merchantId, p.id);
    if (page >= (r.pagination?.totalPages || 1)) break;
  }
  console.log('انتهت المعالجة الشاملة');
});

app.get('/', (_req, res) => res.send('Salla Smart Tags is running'));

if (require.main === module) {
  app.listen(process.env.PORT || 3000, () => console.log('listening'));
}
module.exports = { app, contentHash };
