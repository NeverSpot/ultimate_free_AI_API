import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  generateOtp,
  hashOtp,
  looksLikeEmail,
  normalizeEmail,
  otpMatches,
  OTP_LENGTH,
} from '../../src/lib/otp';
import { escapeHtml, otpMail } from '../../src/lib/mailer';

describe('generateOtp', () => {
  test('always returns a zero-padded six-digit string', () => {
    for (let index = 0; index < 200; index += 1) {
      const code = generateOtp();
      assert.equal(code.length, OTP_LENGTH);
      assert.match(code, /^\d{6}$/);
    }
  });
});

describe('hashOtp / otpMatches', () => {
  const pepper = 'test-pepper';

  test('matches only the exact code for the same address', () => {
    const hash = hashOtp('123456', 'ada@example.com', pepper);
    assert.equal(otpMatches('123456', 'ada@example.com', pepper, hash), true);
    assert.equal(otpMatches('123456', 'other@example.com', pepper, hash), false);
    assert.equal(otpMatches('654321', 'ada@example.com', pepper, hash), false);
  });

  test('rejects a hash with a different pepper', () => {
    const hash = hashOtp('123456', 'ada@example.com', pepper);
    assert.equal(otpMatches('123456', 'ada@example.com', 'other-pepper', hash), false);
  });

  test('never stores the code in plaintext', () => {
    const hash = hashOtp('123456', 'ada@example.com', pepper);
    assert.doesNotMatch(hash, /123456/);
    assert.equal(hash.length, 64);
  });
});

describe('normalizeEmail / looksLikeEmail', () => {
  test('lowercases and trims', () => {
    assert.equal(normalizeEmail('  Ada@Example.COM '), 'ada@example.com');
  });

  test('accepts real addresses and rejects obvious noise', () => {
    assert.equal(looksLikeEmail('ada@example.com'), true);
    assert.equal(looksLikeEmail('ada+tag@sub.example.co.uk'), true);
    assert.equal(looksLikeEmail('ada'), false);
    assert.equal(looksLikeEmail('ada@'), false);
    assert.equal(looksLikeEmail('ada @example.com'), false);
  });
});

describe('otpMail', () => {
  test('puts the code in the subject so it is readable from a notification', () => {
    const mail = otpMail({ code: '123456', ttlMinutes: 10 });
    assert.match(mail.subject, /^123456 /);
    assert.match(mail.text, /123456/);
    assert.match(mail.text, /10 minutes/);
    assert.match(mail.html ?? '', /123456/);
  });

  test('escapes the app name in the HTML part', () => {
    const mail = otpMail({ code: '123456', ttlMinutes: 10, appName: '<script>x</script>' });
    assert.doesNotMatch(mail.html ?? '', /<script>/);
    assert.match(mail.html ?? '', /&lt;script&gt;/);
  });

  test('escapeHtml covers the five HTML metacharacters', () => {
    assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  });
});
