import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const kv = () => { const m = new Map(); return { m, put: async (k, v) => m.set(k, v), get: async (k) => m.get(k) ?? null, delete: async (k) => m.delete(k) }; };
async function sign(secret, body) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const body = JSON.stringify({ event: 'app.store.authorize', merchant: 123, data: { access_token: 'a', refresh_token: 'r', expires: 1900000000 } });
const post = (headers) => new Request('https://x.test/webhook', { method: 'POST', body, headers });

test('signature strategy accepts valid, rejects invalid', async () => {
  const env = { SALLA_WEBHOOK_SECRET: 's3cret', TOKENS: kv() };
  const ok = await worker.fetch(post({ 'x-salla-security-strategy': 'signature', 'x-salla-signature': await sign('s3cret', body) }), env);
  assert.equal(ok.status, 200);
  assert.ok(env.TOKENS.m.get('merchant:123'));
  const bad = await worker.fetch(post({ 'x-salla-signature': 'deadbeef' }), { ...env, TOKENS: kv() });
  assert.equal(bad.status, 401);
});
test('token strategy compares Authorization with secret', async () => {
  const env = { SALLA_WEBHOOK_SECRET: 's3cret', TOKENS: kv() };
  assert.equal((await worker.fetch(post({ 'x-salla-security-strategy': 'token', authorization: 's3cret' }), env)).status, 200);
  assert.equal((await worker.fetch(post({ 'x-salla-security-strategy': 'token', authorization: 'nope' }), env)).status, 401);
});
