import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyDay, addOrder, roundDay, sumDays, seriesOf } from '../src/agg.js';
import { normalizeOrder } from '../src/salla.js';

const order = (day, hour, status, total, items = [], extra = {}) => normalizeOrder({ id: 1, reference_id: 1, total: { amount: total }, date: { date: `${day} ${String(hour).padStart(2, '0')}:00:00.000000` },
  status: { slug: status }, items, payment_method: 'mada', customer: { id: 1, city: 'جدة' }, source: 'store', ...extra });

test('addOrder + sumDays: totals, statuses, breakdowns, hours, weekday', () => {
  const a = emptyDay('2026-10-04'), b = emptyDay('2026-10-05');   // أحد، إثنين
  addOrder(a, order('2026-10-04', 9, 'completed', 100, [{ name: 'X', quantity: 2 }]));
  addOrder(a, order('2026-10-04', 9, 'canceled', 40));
  addOrder(b, order('2026-10-05', 21, 'in_progress', 60, [{ name: 'X', quantity: 1 }, { name: 'Y', quantity: 1 }], { payment_method: 'cod' }));
  addOrder(b, order('2026-10-05', 22, 'restored', 30));
  const s = sumDays([a, b].map(roundDay));
  assert.deepEqual([s.orders, s.valid, s.revenue, s.lost, s.lostValue, s.sold, s.aov], [4, 2, 160, 2, 70, 4, 80]);
  assert.deepEqual(s.counts, { completed: 1, shipping: 1, canceled: 1, refunded: 1 });
  assert.deepEqual(s.pay.map((p) => [p.k, p.total]), [['mada', 100], ['cod', 60]]);
  assert.equal(s.hours[9], 1); assert.equal(s.hours[21], 1);
  assert.deepEqual([s.dow[0], s.dow[1]], [1, 1]);
  assert.equal(s.products[0].name, 'X'); assert.equal(s.products[0].qty, 3);
  assert.equal(s.productsCount, 2);
  assert.deepEqual(seriesOf([a, b]).map((x) => x.slice(0, 3)), [['2026-10-04', 2, 100], ['2026-10-05', 2, 60]]);
  assert.equal(sumDays([a, b], false).pay, undefined);
});

test('cancelled/refunded breakdown: counts, values, rate, products, payment, city', () => {
  const a = emptyDay('2026-10-04'), b = emptyDay('2026-10-05');
  addOrder(a, order('2026-10-04', 9, 'completed', 100, [{ name: 'X', quantity: 1 }]));
  addOrder(a, order('2026-10-04', 9, 'canceled', 80, [{ name: 'X', quantity: 2 }, { name: 'Y', quantity: 1 }], { payment_method: 'cod' }));
  addOrder(b, order('2026-10-05', 9, 'canceled', 20, [{ name: 'Y', quantity: 1 }]));
  addOrder(b, order('2026-10-05', 9, 'restored', 50, [{ name: 'Z', quantity: 1 }]));
  const s = sumDays([a, b].map(roundDay));
  const c = s.lostDetail.canceled, r = s.lostDetail.refunded;
  assert.deepEqual([c.count, c.value, c.avg, c.rate], [2, 100, 50, 50]);
  assert.deepEqual(c.products.map((p) => [p.name, p.qty]), [['X', 2], ['Y', 2]]);
  assert.deepEqual(c.pay.map((p) => [p.k, p.total]), [['cod', 80], ['mada', 20]]);
  assert.deepEqual([r.count, r.value, r.products[0].name], [1, 50, 'Z']);
  assert.equal(s.lostValue, 150);
  assert.deepEqual(seriesOf([a, b]).map((x) => x.slice(3)), [[1, 80, 0, 0], [1, 20, 1, 50]]);
  // صفوف قديمة بلا lost لا تكسر الجمع
  const old = emptyDay('2026-10-06'); delete old.lost; old.orders = 1; old.canceled = 1;
  assert.equal(sumDays([old]).lostDetail.canceled.count, 1);
});

test('sumDays: productSales = product lines only (no shipping/tax) and drives unit price', async () => {
  const { emptyDay, addOrder, roundDay, sumDays } = await import('../src/agg.js');
  const d = emptyDay('2026-10-10');
  addOrder(d, { status: 'completed', total: 150, paymentMethod: 'mada', city: 'x', source: 's', hour: 10, qty: 3, customerId: 1,
    lines: [{ name: 'A', qty: 2, price: 40, img: '' }, { name: 'B', qty: 1, price: 50, img: '' }] });   // 130 منتجات + 20 شحن/ضريبة
  const s = sumDays([roundDay(d)]);
  assert.equal(s.revenue, 150);
  assert.equal(s.productSales, 130);
  assert.equal(s.sold, 3);
  assert.equal(sumDays([roundDay(d)], false).productSales, 130);   // الفترة السابقة (بلا تفاصيل) تحمل القيمة أيضاً
});

test('categoryStats: sales/units/share per category, uncategorized bucket, ordered by sales', async () => {
  const { categoryStats } = await import('../src/agg.js');
  const d = emptyDay('2026-10-10');
  addOrder(d, { status: 'completed', total: 400, paymentMethod: 'mada', city: 'x', source: 's', hour: 10, qty: 6, customerId: 1,
    lines: [{ name: 'Dress ', qty: 2, price: 100, img: '' }, { name: 'Shoe', qty: 1, price: 100, img: '' }, { name: 'Mystery', qty: 3, price: 33.33, img: '' }] });
  const r = categoryStats([roundDay(d)], new Map([['dress', 'فساتين'], ['shoe', 'أحذية']]));
  assert.deepEqual(r.list.map((c) => [c.name, c.qty, c.total]), [['فساتين', 2, 200], ['أحذية', 1, 100], ['', 3, 99.99]]);
  assert.equal(Math.round(r.list[0].share), 50);
  assert.equal(r.units, 6);
});

test('VAT factor: product sales / category totals include tax for taxable products only', async () => {
  const { categoryStats } = await import('../src/agg.js');
  const d = emptyDay('2026-10-10');
  addOrder(d, { status: 'completed', total: 300, paymentMethod: 'mada', city: 'x', source: 's', hour: 10, qty: 3, customerId: 1,
    lines: [{ name: 'Taxed', qty: 2, price: 100, img: '' }, { name: 'Exempt', qty: 1, price: 100, img: '' }] });
  const vat = new Map([['taxed', 1.15]]);                       // Exempt غير خاضع
  const s = sumDays([roundDay(d)], true, vat);
  assert.equal(s.productSales, 330);                            // 200×1.15 + 100
  assert.equal(Math.round((s.productSales / s.sold) * 100) / 100, 110);
  const r = categoryStats([roundDay(d)], new Map([['taxed', 'أ'], ['exempt', 'ب']]), vat);
  assert.deepEqual(r.list.map((c) => [c.name, c.total]), [['أ', 230], ['ب', 100]]);
});
