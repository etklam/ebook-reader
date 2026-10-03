// L1 unit tests for the auth throttle (M7 hardening).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from './rate-limit.ts';

test('allows up to max then refuses with a positive retryAfter', () => {
  const rl = createRateLimiter({ windowMs: 60_000, max: 3 });
  for (let i = 0; i < 3; i++) {
    assert.equal(rl.check('a').allowed, true, `attempt ${i + 1} should pass`);
  }
  const refused = rl.check('a');
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAfter >= 1 && refused.retryAfter <= 60, `retryAfter ${refused.retryAfter}`);
});

test('buckets are independent per key', () => {
  const rl = createRateLimiter({ windowMs: 60_000, max: 1 });
  assert.equal(rl.check('a').allowed, true);
  assert.equal(rl.check('a').allowed, false);
  assert.equal(rl.check('b').allowed, true, 'a different key must not inherit the refusal');
});

test('window expiry lets a key through again', async () => {
  const rl = createRateLimiter({ windowMs: 40, max: 1 });
  assert.equal(rl.check('a').allowed, true);
  assert.equal(rl.check('a').allowed, false);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(rl.check('a').allowed, true, 'hits older than the window must be forgotten');
});

test('clear credits a bucket (successful login must not lock the account)', () => {
  const rl = createRateLimiter({ windowMs: 60_000, max: 2 });
  assert.equal(rl.check('u').allowed, true);
  rl.clear('u');
  assert.equal(rl.check('u').allowed, true);
  rl.clear('u');
  assert.equal(rl.check('u').allowed, true, 'a cleared bucket starts over');
});

test('key count stays bounded under key rotation', () => {
  // an attacker rotating source addresses must not grow the map without limit
  const rl = createRateLimiter({ windowMs: 60_000, max: 5 }, 50);
  for (let i = 0; i < 5_000; i++) rl.check(`ip-${i}`);
  assert.ok(rl.size() <= 50, `size ${rl.size()} must stay within the ceiling`);
});

test('a refused key is not evicted by rotation', () => {
  const rl = createRateLimiter({ windowMs: 60_000, max: 1 }, 10);
  rl.check('victim');
  assert.equal(rl.check('victim').allowed, false);
  for (let i = 0; i < 200; i++) rl.check(`noise-${i}`);
  assert.equal(rl.check('victim').allowed, false, 'eviction must not reset a sustained attacker');
});

test('rejects nonsensical rules instead of silently allowing everything', () => {
  assert.throws(() => createRateLimiter({ windowMs: 1_000, max: 0 }), /max must be/);
  assert.throws(() => createRateLimiter({ windowMs: 0, max: 1 }), /windowMs must be/);
});
