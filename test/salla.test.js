import test from 'node:test';
import assert from 'node:assert/strict';
import { mapStatus, parseSallaDate, normalizeOrder } from '../src/salla.js';

test('mapStatus', () => {
  assert.equal(mapStatus('completed'), 'completed');
  assert.equal(mapStatus('canceled'), 'canceled');
  assert.equal(mapStatus('restored'), 'refunded');
  assert.equal(mapStatus('in_progress'), 'shipping');
  assert.equal(mapStatus('under_review'), 'shipping');
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
    customer: { full_name: 'Mohammed Ahmed' }
  });
  assert.deepEqual([o.id, o.customer, o.status, o.total, o.qty], [275839672, 'Mohammed Ahmed', 'shipping', 16.39, 2]);
  assert.equal(o.lines.length, 2);
  assert.equal(o.lines[0].price, 16.39 / 2);
  assert.equal(o.lines[1].img, '');
});
