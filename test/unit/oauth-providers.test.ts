import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signWithKey, type JsonWebKey } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  codeChallengeFor,
  createCodeVerifier,
  OAuthError,
  stateMatches,
  verifyGoogleIdToken,
} from '../../src/lib/oauth/providers';

const CLIENT_ID = 'client-id.apps.googleusercontent.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk: JsonWebKey = {
  ...(publicKey.export({ format: 'jwk' }) as JsonWebKey),
  kid: 'kid-1',
  alg: 'RS256',
};

function token(claims: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'kid-1', ...header })).toString(
    'base64url',
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 600,
      sub: 'sub-1',
      email: 'ada@example.com',
      email_verified: true,
      ...claims,
    }),
  ).toString('base64url');
  const signature = signWithKey('RSA-SHA256', Buffer.from(`${head}.${payload}`), privateKey);
  return `${head}.${payload}.${signature.toString('base64url')}`;
}

function verify(idToken: string, extra: { nonce?: string; now?: () => number } = {}) {
  return verifyGoogleIdToken(idToken, {
    clientId: CLIENT_ID,
    jwks: [jwk],
    ...extra,
  });
}

describe('verifyGoogleIdToken', () => {
  test('accepts a correctly signed token and returns its claims', () => {
    const claims = verify(token({ nonce: 'n-1' }), { nonce: 'n-1' });
    assert.equal(claims.sub, 'sub-1');
    assert.equal(claims.email, 'ada@example.com');
  });

  test('rejects a tampered payload', () => {
    const valid = token({});
    const [head, , signature] = valid.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({
        sub: 'attacker',
        email: 'evil@example.com',
        aud: CLIENT_ID,
        exp: 9_999_999_999,
      }),
    ).toString('base64url');
    assert.throws(
      () => verify(`${head}.${forgedPayload}.${signature}`),
      (error: unknown) => error instanceof OAuthError && error.code === 'invalid_id_token',
    );
  });

  test('rejects an unexpected audience', () => {
    assert.throws(() => verify(token({ aud: 'someone-else' })), /unexpected audience/);
  });

  test('rejects an expired token', () => {
    assert.throws(() => verify(token({ exp: Math.floor(Date.now() / 1000) - 5 })), /expired/);
  });

  test('rejects a nonce mismatch', () => {
    assert.throws(() => verify(token({ nonce: 'other' }), { nonce: 'expected' }), /nonce/);
  });

  test('rejects an unexpected algorithm', () => {
    assert.throws(() => verify(token({}, { alg: 'none' })), /algorithm/);
  });
});

describe('PKCE and state helpers', () => {
  test('derives an S256 challenge of the right shape', () => {
    const verifier = createCodeVerifier();
    assert.equal(verifier.length, 43);
    const challenge = codeChallengeFor(verifier);
    assert.equal(challenge.length, 43);
    assert.doesNotMatch(challenge, /[+/=]/);
    assert.equal(codeChallengeFor(verifier), challenge);
  });

  test('compares state values in constant time and rejects length mismatches', () => {
    assert.equal(stateMatches('abc', 'abc'), true);
    assert.equal(stateMatches('abc', 'abd'), false);
    assert.equal(stateMatches('abc', 'abcd'), false);
  });
});
