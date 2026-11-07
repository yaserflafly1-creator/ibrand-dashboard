import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProductPage, toNum, validCompetitorUrl, checkCompetitorUrl } from '../src/comp.js';

test('toNum: Arabic digits, thousands and decimal commas', () => {
  assert.equal(toNum('١٢٣٫٥٠'), 123.5); assert.equal(toNum('1,299.50'), 1299.5); assert.equal(toNum('12,50'), 12.5); assert.equal(toNum('1,299'), 1299);
  assert.equal(toNum('SAR 45'), 45); assert.equal(toNum('0'), null); assert.equal(toNum(''), null); assert.equal(toNum(null), null);
});

test('parseProductPage: JSON-LD Product (single, graph, offers array), availability, title', () => {
  const ld = (o) => `<html><head><script type="application/ld+json">${JSON.stringify(o)}</script></head></html>`;
  assert.deepEqual(parseProductPage(ld({ '@type': 'Product', name: 'حليب &amp; نمو', offers: { '@type': 'Offer', price: '89.90', priceCurrency: 'SAR', availability: 'https://schema.org/InStock' } })), { price: 89.9, currency: 'SAR', avail: 1, title: 'حليب & نمو' });
  const g = parseProductPage(ld({ '@graph': [{ '@type': 'WebSite' }, { '@type': ['Product'], name: 'X', offers: [{ price: 0 }, { price: 12, availability: 'OutOfStock' }] }] }));
  assert.equal(g.price, 12); assert.equal(g.avail, 0);
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
