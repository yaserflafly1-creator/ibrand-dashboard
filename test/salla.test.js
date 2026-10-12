import test from 'node:test';
import assert from 'node:assert/strict';
import { mapStatus, parseSallaDate, normalizeOrder, buildPriceMap, applyCatalog, normalizeInventoryItem, normalizeCoupon, normalizeShipment, shipmentGroup } from '../src/salla.js';

test('mapStatus', () => {
  assert.equal(mapStatus('completed'), 'completed');
  assert.equal(mapStatus('canceled'), 'canceled');
  assert.equal(mapStatus('restored'), 'refunded');
  assert.equal(mapStatus('in_progress'), 'shipping');
  assert.equal(mapStatus('under_review'), 'shipping');
  assert.equal(mapStatus('shipped'), 'shipping');
  assert.equal(mapStatus('delivered'), 'completed');
  assert.equal(mapStatus('payment_failed'), 'canceled');
  assert.equal(mapStatus('payment_pending'), 'unpaid');
});
test('parseSallaDate uses Riyadh time', () => {
  assert.equal(parseSallaDate({ date: '2026-10-01 03:00:00.000000' }), Date.parse('2026-10-01T00:00:00Z'));
});
test('normalizeOrder follows List Orders shape', () => {
  const o = normalizeOrder({
    id: 1333249299, reference_id: 275839672, draft: false,
    total: { amount: 16.39, currency: 'SAR' },
    date: { date: '2026-08-02 18:08:47.000000', timezone: 'Asia/Riyadh' },
    status: { slug: 'in_progress' },
    items: [{ name: 'Perfumes Package', quantity: 1, thumbnail: 'x.png' }, { name: 'Dress', quantity: 1, thumbnail: null }],
    customer: { id: 77, full_name: 'Mohammed Ahmed', city: 'جدة' }, payment_method: 'mada', source: 'store'
  });
  assert.deepEqual([o.id, o.customer, o.status, o.total, o.qty], [275839672, 'Mohammed Ahmed', 'shipping', 16.39, 2]);
  assert.deepEqual([o.customerId, o.city, o.paymentMethod, o.source], [77, 'جدة', 'mada', 'store']);
  assert.equal(o.lines.length, 2);
  assert.equal(o.lines[0].price, 16.39 / 2);
  assert.equal(o.lines[1].img, '');
});
test('applyCatalog prices lines by product name (sale price wins)', () => {
  const orders = [normalizeOrder({ id: 1, total: { amount: 100 }, items: [{ name: 'Dress', quantity: 2 }, { name: 'Unknown', quantity: 1 }] })];
  const map = buildPriceMap([{ name: 'dress ', price: { amount: 60 }, sale_price: { amount: 45 }, thumbnail: 't.png' }]);
  const r = applyCatalog(orders, map);
  assert.deepEqual(r, { matched: 1, total: 2 });
  assert.equal(orders[0].lines[0].price, 45);
  assert.equal(orders[0].lines[0].img, 't.png');
  assert.equal(orders[0].lines[1].price, 100 / 3);
});
test('normalizeInventoryItem follows Product Quantities shape', () => {
  const i = normalizeInventoryItem({ id: 1730800454, name: 'SSD', image: 'a.jpg', sku_id: 442024243, sku: 'sam-ssd-128g', quantity: 127, sold_quantity: 340, price: '150.00', unlimited_quantity: false, variant: '128G - black' });
  assert.deepEqual([i.qty, i.sold, i.price, i.unlimited, i.variant, i.skuId], [127, 340, 150, false, '128G - black', 442024243]);
  assert.equal(normalizeInventoryItem({ id: 2, name: 'x', sku: null, variant: null, image: null }).sku, '');
});
test('normalizeCoupon: types, statistics may be missing', () => {
  const a = normalizeCoupon({ id: 1, code: 'DEAL', type: 'p', status: 'active', amount: { amount: 20, currency: 'SAR' }, usage_limit: 90, expiry_date: '2030-01-01 00:00:00',
    statistics: { num_of_usage: 5, num_of_customers: 4, coupon_sales: { amount: 300 } }, free_shipping: true });
  assert.deepEqual([a.type, a.value, a.uses, a.customers, a.sales, a.usageLimit, a.freeShipping], ['percentage', 20, 5, 4, 300, 90, true]);
  const b = normalizeCoupon({ id: 2, code: 'X', type: 'Fixed', amount: { amount: 30 } });
  assert.deepEqual([b.type, b.uses, b.sales], ['fixed', null, null]);
});
test('shipments: status groups and normalization', () => {
  assert.deepEqual(['delivered', 'partially_delivered', 'in_transit', 'lost', 'return_to_origin', 'unknown_x'].map(shipmentGroup),
    ['delivered', 'delivered', 'transit', 'failed', 'returned', 'transit']);
  const s = normalizeShipment({ id: 'a1', courier_name: 'SMSA', status: 'delivered', payment_method: 'cod', ship_to: { city: 'جدة' }, total: { amount: 150 }, tracking_number: 'T1' });
  assert.deepEqual([s.courier, s.group, s.cod, s.city, s.total, s.tracking], ['SMSA', 'delivered', true, 'جدة', 150, 'T1']);
});
