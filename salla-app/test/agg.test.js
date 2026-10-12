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
  assert.deepEqual(seriesOf([a, b]), [['2026-10-04', 2, 100], ['2026-10-05', 2, 60]]);
  assert.equal(sumDays([a, b], false).pay, undefined);
});
