import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secretHint } from '../src/application/secret-hint.js';
test('saved secret references expose only identifiable ends of long secrets', () => {
  assert.equal(secretHint('abcd-private-secret-wxyz'), 'abcd••••••••wxyz');
  assert.equal(secretHint('short-secret'), '••••••••');
  assert.equal(secretHint(''), undefined);
});
