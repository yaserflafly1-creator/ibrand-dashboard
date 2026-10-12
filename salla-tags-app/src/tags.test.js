const test = require('node:test');
const assert = require('node:assert');
const { normalize, parseTags } = require('./tags');

test('normalize يزيل المكرر والفراغات و#', () => {
  assert.deepStrictEqual(normalize(['#عطر', ' عطر ', 'Perfume', 'perfume', '']), ['عطر', 'Perfume']);
});

test('parseTags يستخرج JSON من نص محاط', () => {
  assert.deepStrictEqual(parseTags('هذا:\n```json\n{"tags":["أ","ب"]}\n```'), ['أ', 'ب']);
});
