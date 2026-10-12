import test from 'node:test';
import assert from 'node:assert/strict';
import { mapStatus, parseSallaDate, normalizeOrder, normalizeItems } from '../src/salla.js';

test('mapStatus', () => {
  assert.equal(mapStatus('completed'), 'completed');
  assert.equal(mapStatus('canceled'), 'canceled');
  assert.equal(mapStatus('restored'), 'refunded');
  assert.equal(mapStatus('under_review'), 'shipping');
});
test('parseSallaDate uses Riyadh time', () => {
  assert.equal(parseSallaDate({ date: '2026-10-01 03:00:00.000000' }), Date.parse('2026-10-01T00:00:00Z'));
});
test('normalizeOrder / items', () => {
  const o = normalizeOrder({ id: 1, reference_id: 5001, date: { date: '2026-10-01 10:00:00.000000' }, status: { slug: 'completed' },
    amounts: { total: { amount: 250 } }, customer: { first_name: 'سارة', last_name: 'علي' } });
  assert.deepEqual([o.id, o.customer, o.status, o.total], [5001, 'سارة علي', 'completed', 250]);
  const l = normalizeItems({ items: [{ name: 'عطر', quantity: 2, amounts: { total: { amount: 200 } } }] });
  assert.deepEqual([l[0].qty, l[0].price], [2, 100]);
});
