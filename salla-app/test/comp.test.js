import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProductPage, toNum, validCompetitorUrl, checkCompetitorUrl } from '../src/comp.js';

test('toNum: Arabic digits, thousands and decimal commas', () => {
  assert.equal(toNum('١٢٣٫٥٠'), 123.5); assert.equal(toNum('1,299.50'), 1299.5); assert.equal(toNum('12,50'), 12.5); assert.equal(toNum('1,299'), 1299);
  assert.equal(toNum('SAR 45'), 45); assert.equal(toNum('0'), null); assert.equal(toNum(''), null); assert.equal(toNum(null), null);
});

test('parseProductPage: JSON-LD Product (single, graph, offers array), availability, title', () => {
  const ld = (o) => `<html><head><script type="application/ld+json">${JSON.stringify(o)}</script></head></html>`;
  assert.deepEqual(parseProductPage(ld({ '@type': 'Product', name: 'حليب &amp; نمو', offers: { '@type': 'Offer', price: '89.90', priceCurrency: 'SAR', availability: 'https://schema.org/InStock' } })), { price: 89.9, currency: 'SAR', avail: 1, title: 'حليب & نمو', codes: [], brand: '' });
  const g = parseProductPage(ld({ '@graph': [{ '@type': 'WebSite' }, { '@type': ['Product'], name: 'X', offers: [{ price: 0 }, { price: 12, availability: 'OutOfStock' }] }] }));
  assert.equal(g.price, 12); assert.equal(g.avail, 0);
  assert.deepEqual(parseProductPage(ld({ '@type': 'Product', name: 'B', sku: '6281008298482', mpn: 'abc', gtin13: '6281008298482', offers: { price: 5 } })).codes, ['6281008298482']);   // الباركود من sku/gtin
  assert.equal(parseProductPage(ld({ '@type': 'Product', name: 'Y', offers: { '@type': 'AggregateOffer', lowPrice: '7.5' } })).price, 7.5);
  assert.equal(parseProductPage('<script type="application/ld+json">{bad json</script><script type="application/ld+json">{"@type":"Product","name":"Z","offers":{"price":3}}</script>').price, 3);
});

test('parseProductPage: meta fallbacks and no-price pages', () => {
  const m = parseProductPage('<head><title>صفحة</title><meta property="og:title" content="منتج"><meta property="product:price:amount" content="45.00"><meta property="product:price:currency" content="SAR"><meta property="og:availability" content="instock"></head>');
  assert.equal(m.price, 45); assert.equal(m.currency, 'SAR'); assert.equal(m.title, 'منتج');
  assert.equal(parseProductPage('<span itemprop="price" content="19.5">19.5</span>').price, 19.5);
  assert.equal(parseProductPage('<html><body>لا سعر هنا</body></html>'), null);
});

test('validCompetitorUrl: https public domains only', () => {
  assert.equal(validCompetitorUrl('https://www.nahdionline.com/ar/p/1'), 'https://www.nahdionline.com/ar/p/1');
  for (const bad of ['http://a.com/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://10.0.0.1', 'ftp://a.com', 'نص', '', 'https://intranet.internal/x', 'https://nodot/x']) assert.equal(validCompetitorUrl(bad), null, bad);
});

test('checkCompetitorUrl: ok, HTTP errors, blocked, no price, network failure', async () => {
  const page = '<script type="application/ld+json">{"@type":"Product","name":"P","offers":{"price":10,"priceCurrency":"SAR"}}</script>';
  assert.equal((await checkCompetitorUrl('https://a.com/p', async () => new Response(page))).price, 10);
  assert.match((await checkCompetitorUrl('https://a.com/p', async () => new Response('x', { status: 403 }))).err, /403.*يحجب/);
  assert.match((await checkCompetitorUrl('https://a.com/p', async () => new Response('x', { status: 404 }))).err, /404/);
  assert.match((await checkCompetitorUrl('https://a.com/p', async () => new Response('<p>بلا سعر</p>'))).err, /لا يوجد سعر/);
  assert.match((await checkCompetitorUrl('https://a.com/p', async () => new Response('<meta http-equiv="refresh" content="0;url=\'https://a.com/\'">'))).err, /محوّلة/);
  assert.equal((await checkCompetitorUrl('https://a.com/p', async () => { throw new Error('x'); })).err, 'تعذّر الجلب');
});

import { matchScore, tokens, suggestFor, brandSlugFor, learnBrand } from '../src/suggest.js';

test('matchScore: Arabic normalisation, units, numbers must agree', () => {
  assert.equal(matchScore('سيميلاك جولد حليب الرضع (2) 800 جم', 'سيميلاك جولد حليب الرضع (2) 800 جم'), 1);
  assert.ok(matchScore('سيميلاك جولد حليب الرضع (2) 800 جم', 'حليب سيميلاك جولد رقم 2 عبوة 800 جرام') >= 0.75);       // جرام = جم
  assert.ok(matchScore('سيميلاك جولد حليب (2) 800 جم', 'سيميلاك جولد حليب رقم 2 عبوة 400 جرام') < 0.75);              // الحجم مختلف
  assert.ok(matchScore('بيبي جوي مقاس 5 جامبو 80 حفاضة', 'بيبي جوي مقاس 3 صندوق جامبو 104 حفاضة') < 0.6);
  assert.deepEqual(tokens('كريم (٢٥٠) مل'), ['كريم', '250', 'مل']);
  assert.equal(matchScore('', 'x'), 0);
});

test('suggestFor: Shopify-style search + sitemap matching, scored by real page title; fetch failures are tolerated', async () => {
  const prod = (title, price) => `<script type="application/ld+json">{"@type":"Product","name":"${title}","offers":{"price":${price}}}</script>`;
  const kv = { m: new Map(), get: async (k) => kv.m.get(k) ?? null, put: async (k, v) => kv.m.set(k, v) };
  const pages = {
    'https://sidalih.com/products/a': prod('بيبي جوي مقاس (5) صندوق جامبو 80 حفاضة', 95), 'https://sidalih.com/products/b': prod('بيبي جوي مقاس 3 صندوق جامبو 104 حفاضة', 96),
    'https://pharmabrand.sa/ar/بيبي-جوي-مقاس-5-جامبو-80-حفاضة/p1': prod('حفاضات بيبي جوي مقاس 5 جامبو 80 حفاضة', 90)
  };
  const calls = [];
  const f = async (u) => {
    u = String(u); calls.push(u);
    if (u.startsWith('https://sidalih.com/search')) return new Response('<a href="/products/a?_pos=1"></a><a href="/products/b"></a><a href="/products/a"></a>');
    if (u === 'https://pharmabrand.sa/sitemap.xml') return new Response('<loc>https://pharmabrand.sa/ar/sitemap-1.xml</loc><loc>https://pharmabrand.sa/en/sitemap-1.xml</loc>');
    if (u === 'https://pharmabrand.sa/ar/sitemap-1.xml') return new Response('<loc>https://pharmabrand.sa/ar/%D8%A8%D9%8A%D8%A8%D9%8A-%D8%AC%D9%88%D9%8A-%D9%85%D9%82%D8%A7%D8%B3-5-%D8%AC%D8%A7%D9%85%D8%A8%D9%88-80-%D8%AD%D9%81%D8%A7%D8%B6%D8%A9/p1</loc><loc>https://pharmabrand.sa/ar/صابون-ازرق/p2</loc>');
    if (u === 'https://daralamirat.com.sa/sitemap.xml') throw new Error('down');
    const key = decodeURI(u).replace('?_pos=1', ''); const hit = pages[u] || pages[key] || pages[u.replace(/\?.*/, '')];
    return hit ? new Response(`<html>${hit}</html>`) : new Response('', { status: 404 });
  };
  const r = await suggestFor('بيبي جوي مقاس (5) صندوق جامبو 80 حفاضة', { fetchFn: f, kv });
  assert.equal(r[0].competitor, 'صيدلية كوم'); assert.equal(r[0].score, 1); assert.equal(r[0].price, 95);
  assert.ok(r.some((x) => x.competitor === 'فارما براند' && x.score >= 0.75));
  assert.ok(r.find((x) => x.url.endsWith('/b')).score < 0.75);              // نفس العلامة لكن مقاس/عدد مختلف
  assert.ok(!r.some((x) => x.competitor === 'دار الأميرات'));                // موقع متعطل لا يكسر الباقي
  assert.ok(kv.m.has('sm:فارما براند'));                                    // الخريطة تُخزَّن
  const before = calls.length; await suggestFor('بيبي جوي مقاس (5) صندوق جامبو 80 حفاضة', { fetchFn: f, kv });
  assert.ok(!calls.slice(before).includes('https://pharmabrand.sa/sitemap.xml'));   // من التخزين لا من الشبكة
});

test('matchScore: rejects look-alikes from real review screenshots, accepts true variants', () => {
  const no = [
    ['بيبي جوي مقاس (6) صندوق جامبو 60 حفاضة', 'فاين بيبي توتال 7 مقاس ( 1 ) حديث الولادة عبوة جامبو 60 حفاضة'],   // علامة مختلفة
    ['بيبي جوي كلوت جامبو صندوق(6) اولاد 1*64', 'بيبي جوي مضغوطة المولود الجديد (1) حتى 4 كيلو صندوق جامبو 136 حفاض'],
    ['ابتاميل (1) 400 جم', 'بلبميل بلس (1) حليب أطفال 400 جم'],                                                      // اسم مختلف بنفس الحجم
    ['فينوس سمبلي ماكينة حلاقة 4+1', 'جيليت فينوس ماكينة حلاقة 4 قطع'],
    ['سيميلاك حليب اطفال ماكس برو (2) 820 جم', 'سيميلاك حليب أطفال ماكس برو (3) من 12 إلى 36 شهر 820 جم'],           // مرحلة 3 ≠ 2
    ['بانادول اكسترا 24 قرص', 'بانادول 500 مجم 24 قرص']];
  for (const [a, b] of no) assert.ok(matchScore(a, b) < 0.5, `${a} <> ${b} = ${matchScore(a, b)}`);
  const yes = [
    ['ابتاميل (1) 400 جم', 'حليب ابتاميل ادفانس رقم 1 عبوة 400 جرام'],
    ['سيميلاك حليب اطفال ماكس برو (2) 820 جم', 'سيميلاك جولد ماكس برو (2) من عمر 6-12 شهر 820 جم'],               // كلمات زائدة عندهم
    ['بيبي جوي مقاس (5) صندوق جامبو 80 حفاضة', 'بيبي جوي مضغوطة كبير جداً (5) 14-23 كيلو صندوق جامبو 80 حفاض'],
    ['بانادول اكسترا 24 قرص', 'بنادول اكسترا 24 قرص']];                                                              // تهجئة بحرف
  assert.ok(matchScore('ابتاميل (1) 400 جم', 'ابتاميل إتش إيه (1) للرضع 400 جم') < 0.85);        // نسخة مختلفة (HA)
  assert.ok(matchScore('جونسون شامبو اطفال 750 مل', 'عرض جونسون شامبو أطفال 750 مل ×3') < 0.6);   // حزمة 3 وحدات
  for (const [a, b] of yes) assert.ok(matchScore(a, b) >= 0.75, `${a} <> ${b} = ${matchScore(a, b)}`);
});

test('suggestFor: learns bilingual brands from matched pages and uses them to find the product on English-slug sites (Nahdi)', async () => {
  const prod = (title, price, brand) => `<html><script type="application/ld+json">{"@type":"Product","name":"${title}","brand":{"@type":"Brand","name":"${brand}"},"offers":{"price":${price}}}</script></html>`;
  const kv = { m: new Map(), get: async (k) => kv.m.get(k) ?? null, put: async (k, v) => kv.m.set(k, v) };
  const f = async (u) => {
    u = String(u);
    if (u === 'https://pharmabrand.sa/sitemap.xml') return new Response('<loc>https://pharmabrand.sa/ar/sitemap-1.xml</loc>');
    if (u === 'https://pharmabrand.sa/ar/sitemap-1.xml') return new Response('<loc>https://pharmabrand.sa/ar/%D8%AD%D9%84%D9%8A%D8%A8-%D8%B3%D9%8A%D9%85%D9%8A%D9%84%D8%A7%D9%83-%D9%85%D8%A7%D9%83%D8%B3-%D8%A8%D8%B1%D9%88-2-820-%D8%AC%D8%B1%D8%A7%D9%85/p1</loc>');
    if (u.startsWith('https://pharmabrand.sa/ar/')) return new Response(prod('حليب سيميلاك ماكس برو رقم 2 عبوة 820 جرام', 170, 'سيميلاك| SIMILAC'));
    if (u === 'https://www.nahdionline.com/sitemap_index_ar.xml') return new Response('<loc>https://www.nahdionline.com/ar/sitemap1.xml</loc>');
    if (u === 'https://www.nahdionline.com/ar/sitemap1.xml') return new Response('<loc>https://www.nahdionline.com/ar-sa/similac-gold-max-pro-stage-2-820-gm/pdp/111</loc><loc>https://www.nahdionline.com/ar-sa/similac-stage-3-820-gm/pdp/222</loc><loc>https://www.nahdionline.com/ar-sa/pampers-pants-4/pdp/333</loc>');
    if (u.endsWith('/pdp/111')) return new Response(prod('سيميلاك حليب أطفال ماكس برو (2) 820 جم', 168, '277191'));
    return new Response('', { status: 404 });
  };
  const name = 'سيميلاك حليب اطفال ماكس برو (2) 820 جم';
  const r = await suggestFor(name, { info: {}, fetchFn: f, kv, sites: ['فارما براند', 'النهدي'] });   // بلا رابط إنجليزي من سلة
  assert.ok(r.some((x) => x.competitor === 'فارما براند' && x.price === 170));
  const nahdi = r.find((x) => x.competitor === 'النهدي'); assert.ok(nahdi && nahdi.price === 168 && nahdi.score >= 0.85);   // وُجدت بفضل العلامة المتعلَّمة similac
  assert.equal(brandSlugFor({ 'سيميلاك': 'similac' }, name), 'similac-milk-2-820');
});

test('learnBrand: bilingual brand strings only', () => {
  const d = {}; assert.equal(learnBrand(d, 'ابتاميل| APTAMIL'), true); assert.equal(learnBrand(d, 'شيا مويستشر - Shea Moisture'), true);
  assert.equal(learnBrand(d, 'بامبرز'), false); assert.equal(learnBrand(d, '277191'), false); assert.equal(learnBrand(d, 'MIELLE'), false);
  assert.deepEqual(d, { 'ابتاميل': 'aptamil', 'شيا مويستشر': 'shea moisture' });
});
