import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from './password.ts';

test('password hash roundtrip', async () => {
  const stored = await hashPassword('正確的密碼123');
  assert.notEqual(stored, '正確的密碼123');
  assert.ok(await verifyPassword('正確的密碼123', stored));
});

test('wrong password rejected', async () => {
  const stored = await hashPassword('正確的密碼123');
  assert.equal(await verifyPassword('錯的密碼', stored), false);
  assert.equal(await verifyPassword('', stored), false);
});

test('malformed stored hash rejected, not thrown', async () => {
  assert.equal(await verifyPassword('x', 'not-a-hash'), false);
  assert.equal(await verifyPassword('x', ''), false);
});

test('same password yields different salts', async () => {
  const a = await hashPassword('same');
  const b = await hashPassword('same');
  assert.notEqual(a, b);
});
