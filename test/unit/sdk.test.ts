import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createGatewayClient } from '../../sdk/client';

test('sdk: client factory returns object with chat.completions.create', () => {
  const client = createGatewayClient('http://localhost:8080/v1', 'test-key');
  assert.strictEqual(typeof client.chat.completions.create, 'function');
});
