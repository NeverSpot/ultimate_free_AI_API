import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { loadCredentialPool } from '../../src/credentials/pool';

function expectedId(provider: string, secret: string): string {
  const hash = createHash('sha256').update(`${provider}\0${secret}`, 'utf8').digest('hex');
  return `${provider}-${hash.slice(0, 16)}`;
}

test('credential pool: parses one key per provider', () => {
  const pool = loadCredentialPool({
    NVIDIA_NIM_KEYS: 'nim-key',
    OPENROUTER_KEYS: 'openrouter-key',
    TOKENHARBOR_KEYS: 'tokenharbor-key',
  });

  assert.deepEqual(pool.providers(), ['nvidia-nim', 'openrouter', 'tokenharbor']);
  assert.equal(pool.size(), 3);
  assert.equal(pool.getCandidates('nvidia-nim')[0]?.secret, 'nim-key');
  assert.equal(pool.credentialsFor('openrouter')[0]?.secret, 'openrouter-key');
  assert.equal(pool.getCandidates('tokenharbor')[0]?.secret, 'tokenharbor-key');
  assert.equal(pool.getCandidates('openrouter')[0]?.label, 'openrouter-1');
});

test('credential pool: three keys for one provider give three distinct credentials', () => {
  const pool = loadCredentialPool({ OPENROUTER_KEYS: 'k1,k2,k3' });
  const credentials = pool.credentialsFor('openrouter');

  assert.equal(credentials.length, 3);
  assert.deepEqual(
    credentials.map((credential) => credential.secret),
    ['k1', 'k2', 'k3'],
  );
  assert.equal(new Set(credentials.map((credential) => credential.id)).size, 3);
});

test('credential pool: blank and whitespace entries are skipped', () => {
  const pool = loadCredentialPool({ NVIDIA_NIM_KEYS: '  a ,, b , ,c,  ' });

  assert.equal(pool.size('nvidia-nim'), 3);
  assert.deepEqual(
    pool.getCandidates('nvidia-nim').map((credential) => credential.secret),
    ['a', 'b', 'c'],
  );

  const whitespaceOnly = loadCredentialPool({ NVIDIA_NIM_KEYS: '   ', OPENROUTER_KEYS: '' });
  assert.equal(whitespaceOnly.size(), 0);
  assert.deepEqual(whitespaceOnly.providers(), []);
});

test('credential pool: a duplicate key within one provider collapses to one', () => {
  const pool = loadCredentialPool({ OPENROUTER_KEYS: 'k1,k1, ,k1' });

  assert.equal(pool.size('openrouter'), 1);
  assert.equal(pool.getCandidates('openrouter')[0]?.secret, 'k1');
});

test('credential pool: the same key under two providers stays two credentials', () => {
  const pool = loadCredentialPool({
    NVIDIA_NIM_KEYS: 'shared-key',
    OPENROUTER_KEYS: 'shared-key',
  });

  assert.equal(pool.size('nvidia-nim'), 1);
  assert.equal(pool.size('openrouter'), 1);
  assert.equal(pool.size(), 2);
  assert.notEqual(pool.getCandidates('nvidia-nim')[0]?.id, pool.getCandidates('openrouter')[0]?.id);
});

test('credential pool: ids are stable across two separate loads of the same env', () => {
  const raw = { OPENROUTER_KEYS: 'alpha,beta,gamma' };
  const first = loadCredentialPool(raw);
  const second = loadCredentialPool({ ...raw });

  const firstIds = first.getCandidates('openrouter').map((credential) => credential.id);
  const secondIds = second.getCandidates('openrouter').map((credential) => credential.id);

  assert.deepEqual(firstIds, secondIds);
  assert.equal(firstIds[0], expectedId('openrouter', 'alpha'));
});

test('credential pool: ids are unique and never contain the key', () => {
  const pool = loadCredentialPool({
    NVIDIA_NIM_KEYS: 'alpha-secret,beta-secret,gamma-secret',
    OPENROUTER_KEYS: 'alpha-secret,beta-secret,gamma-secret',
    TOKENHARBOR_KEYS: 'alpha-secret,beta-secret,gamma-secret',
  });

  const credentials = pool.providers().flatMap((provider) => pool.getCandidates(provider));
  const ids = credentials.map((credential) => credential.id);

  assert.equal(ids.length, 9);
  assert.equal(new Set(ids).size, ids.length);
  for (const credential of credentials) {
    assert.match(credential.id, new RegExp(`^${credential.provider}-[0-9a-f]{16}$`));
    assert.equal(credential.id.includes(credential.secret), false);
  }
});

test('credential pool: getCandidates("unknown") returns []', () => {
  const pool = loadCredentialPool({ OPENROUTER_KEYS: 'k1' });

  assert.deepEqual(pool.getCandidates('unknown'), []);
  assert.equal(pool.size('unknown'), 0);
});

test('credential pool: an empty env yields zero credentials with no throw', () => {
  const pool = loadCredentialPool({});

  assert.equal(pool.size(), 0);
  assert.deepEqual(pool.providers(), []);
  assert.deepEqual(pool.getCandidates('openrouter'), []);
});

test('credential pool: JSON.stringify of a credential does not contain the secret', () => {
  const pool = loadCredentialPool({ OPENROUTER_KEYS: 'sk-json-secret' });
  const credential = pool.getCandidates('openrouter')[0];
  assert.ok(credential);

  const json = JSON.stringify(credential);
  assert.equal(json.includes('sk-json-secret'), false);
  assert.deepEqual(Object.keys(JSON.parse(json) as Record<string, unknown>).sort(), [
    'id',
    'label',
    'provider',
  ]);

  assert.equal(credential.secret, 'sk-json-secret');
  assert.equal(Object.prototype.propertyIsEnumerable.call(credential, 'secret'), false);
  assert.equal(String(credential), `credential:${credential.id}`);
});

test('credential pool: an error message does not contain the secret', () => {
  const raw = {
    NVIDIA_NIM_KEYS: 'sk-good,sk-very-secret\ncontinuation',
  } as unknown as NodeJS.ProcessEnv;

  assert.throws(
    () => loadCredentialPool(raw),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Invalid credential configuration/);
      assert.equal(error.message.includes('sk-very-secret'), false);
      assert.equal(error.message.includes('continuation'), false);
      return true;
    },
  );
});

test('credential pool: a non-string value throws one aggregated error', () => {
  const raw = {
    NVIDIA_NIM_KEYS: 42,
    OPENROUTER_KEYS: 'k1',
  } as unknown as NodeJS.ProcessEnv;

  assert.throws(
    () => loadCredentialPool(raw),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /NVIDIA_NIM_KEYS must be a string/);
      assert.equal(error.message.includes('42'), false);
      return true;
    },
  );
});

test('credential pool: returned arrays are copies', () => {
  const pool = loadCredentialPool({ OPENROUTER_KEYS: 'k1,k2' });

  const candidates = pool.getCandidates('openrouter');
  candidates.pop();

  assert.equal(pool.size('openrouter'), 2);
  assert.equal(pool.getCandidates('openrouter').length, 2);
});
