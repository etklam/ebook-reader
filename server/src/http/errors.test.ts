// L1 unit tests: the error surface must not leak SQL, parameters or schema
// details into logs or response bodies (M7 hardening).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pgCodeOf, scrubError } from './errors.ts';

function driverError(): Error {
  // shape drizzle produces: wrapper Error carrying query/params + a pg cause
  const cause = Object.assign(new Error('invalid input syntax for type uuid: "not-a-uuid"'), { code: '22P02' });
  return Object.assign(new Error('Failed query: delete from "app"."user_library" where ...'), {
    query: 'delete from "app"."user_library" where user_id = $1 and work_id = $2',
    params: ['5d25e443-c312-45ea-a3e0-fdca3ee5a0dd', 'not-a-uuid'],
    cause,
  });
}

test('reads the pg code through the drizzle wrapper', () => {
  assert.equal(pgCodeOf(driverError()), '22P02');
  assert.equal(pgCodeOf(Object.assign(new Error('x'), { code: '23505' })), '23505');
  assert.equal(pgCodeOf(new Error('plain')), undefined);
});

test('scrubbed output contains neither the query nor its parameters', () => {
  const scrubbed = scrubError(driverError());
  assert.ok(!scrubbed.includes('user_library'), `leaked query: ${scrubbed}`);
  assert.ok(!scrubbed.includes('5d25e443'), `leaked parameter: ${scrubbed}`);
  assert.ok(!scrubbed.includes('$1'), `leaked placeholder: ${scrubbed}`);
  assert.equal(scrubbed, 'Error(pg:22P02)');
});

test('non-database errors keep their message for debugging', () => {
  assert.equal(scrubError(new TypeError('x is not a function')), 'TypeError: x is not a function');
});

test('a thrown non-Error does not crash the handler', () => {
  assert.equal(scrubError('boom'), 'non-error thrown');
  assert.equal(scrubError(undefined), 'non-error thrown');
});
