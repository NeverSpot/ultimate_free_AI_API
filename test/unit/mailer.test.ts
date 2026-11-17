import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createMailer, type MailMessage } from '../../src/lib/mailer';

const message: MailMessage = {
  to: 'ada@example.com',
  subject: '123456 is your code',
  text: 'Your code is 123456.',
  html: '<p>Your code is 123456.</p>',
};

describe('createMailer: console transport', () => {
  test('logs the recipient, subject and body so local signup needs no mail server', async () => {
    const lines: string[] = [];
    const mailer = createMailer({
      transport: 'console',
      from: 'no-reply@example.com',
      logger: (line) => lines.push(line),
    });

    await mailer.send(message);

    assert.equal(mailer.transport, 'console');
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? '', /to=ada@example\.com/);
    assert.match(lines[0] ?? '', /123456 is your code/);
    assert.match(lines[0] ?? '', /Your code is 123456\./);
  });

  test('omits the body when logBodies is false, keeping the code out of shared logs', async () => {
    const lines: string[] = [];
    const mailer = createMailer({
      transport: 'console',
      from: 'no-reply@example.com',
      logBodies: false,
      logger: (line) => lines.push(line),
    });

    await mailer.send(message);

    assert.doesNotMatch(lines[0] ?? '', /Your code is 123456\./);
  });
});

describe('createMailer: resend transport', () => {
  test('posts the message to the Resend API with the key in the Authorization header', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response('{"id":"mail_1"}', { status: 200 });
    }) as typeof fetch;

    const mailer = createMailer({
      transport: 'resend',
      from: 'Ultimate Free AI <no-reply@example.com>',
      resendApiKey: 're_test_key',
      fetchImpl,
    });

    await mailer.send(message);

    assert.equal(mailer.transport, 'resend');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://api.resend.com/emails');
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer re_test_key');
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
      from: 'Ultimate Free AI <no-reply@example.com>',
      to: ['ada@example.com'],
      subject: '123456 is your code',
      text: 'Your code is 123456.',
      html: '<p>Your code is 123456.</p>',
    });
  });

  test('throws on a non-2xx response without echoing the provider body', async () => {
    const fetchImpl = (async () =>
      new Response('{"message":"invalid api key re_test_key"}', { status: 401 })) as typeof fetch;

    const mailer = createMailer({
      transport: 'resend',
      from: 'no-reply@example.com',
      resendApiKey: 're_test_key',
      fetchImpl,
    });

    await assert.rejects(mailer.send(message), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 401/);
      assert.doesNotMatch(error.message, /re_test_key/);
      return true;
    });
  });

  test('refuses to construct without an API key', () => {
    assert.throws(
      () => createMailer({ transport: 'resend', from: 'no-reply@example.com' }),
      /RESEND_API_KEY/,
    );
  });
});

describe('createMailer: smtp transport', () => {
  test('refuses to construct without a host instead of failing on the first signup', () => {
    assert.throws(
      () => createMailer({ transport: 'smtp', from: 'no-reply@example.com' }),
      /SMTP_HOST/,
    );
  });

  test('accepts a complete configuration and loads the transport lazily', () => {
    const mailer = createMailer({
      transport: 'smtp',
      from: 'no-reply@example.com',
      smtp: { host: 'smtp.invalid', port: 587, secure: false },
    });

    // Construction alone must not dial the network or import nodemailer.
    assert.equal(mailer.transport, 'smtp');
    assert.equal(typeof mailer.send, 'function');
  });
});
