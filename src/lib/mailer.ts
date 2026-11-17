export type MailTransport = 'console' | 'smtp' | 'resend';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  readonly transport: MailTransport;
  send(message: MailMessage): Promise<void>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
}

export interface MailConfig {
  transport: MailTransport;
  from: string;
  smtp?: SmtpConfig;
  resendApiKey?: string;
  /** Console transport only: print the full message body, not just the subject. */
  logBodies?: boolean;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests. */
  logger?: (line: string) => void;
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 10_000;

/**
 * Transport-agnostic sender.
 *
 * `console` is the development default: the OTP lands in the server log, so the
 * flow is testable with no mail account and no paid provider. Production must
 * configure `smtp` or `resend` (enforced in `loadConfig`).
 */
export function createMailer(config: MailConfig): Mailer {
  const log = config.logger ?? ((line: string) => console.log(line));

  if (config.transport === 'console') {
    return {
      transport: 'console',
      async send(message) {
        const body = config.logBodies === false ? '' : `\n${message.text}`;
        log(`[mail:console] to=${message.to} subject=${message.subject}${body}`);
      },
    };
  }

  if (config.transport === 'resend') {
    const apiKey = config.resendApiKey;
    if (!apiKey) {
      throw new Error('createMailer: RESEND_API_KEY is required for the resend transport');
    }
    const fetchImpl = config.fetchImpl ?? fetch;

    return {
      transport: 'resend',
      async send(message) {
        const response = await fetchImpl(RESEND_ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: config.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            ...(message.html !== undefined ? { html: message.html } : {}),
          }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });

        if (!response.ok) {
          // Never echo the provider body: it can contain the recipient and the key prefix.
          throw new Error(`resend: HTTP ${response.status}`);
        }
      },
    };
  }

  const smtp = config.smtp;
  if (!smtp) {
    throw new Error('createMailer: SMTP_HOST is required for the smtp transport');
  }
  // Re-bind after the guard: TypeScript drops the narrowing inside the async
  // closure below, and a `SmtpConfig` here is the honest type.
  const smtpConfig: SmtpConfig = smtp;

  // Lazily imported so console mode never loads the SMTP stack (and tests stay fast).
  let transportPromise:
    Promise<{ sendMail: (message: Record<string, unknown>) => Promise<unknown> }> | undefined;

  async function smtpTransport(): Promise<{
    sendMail: (message: Record<string, unknown>) => Promise<unknown>;
  }> {
    transportPromise ??= (async () => {
      const module = (await import('nodemailer')) as unknown as {
        createTransport?: (options: Record<string, unknown>) => {
          sendMail: (message: Record<string, unknown>) => Promise<unknown>;
        };
        default?: {
          createTransport?: (options: Record<string, unknown>) => {
            sendMail: (message: Record<string, unknown>) => Promise<unknown>;
          };
        };
      };
      const createTransport = module.createTransport ?? module.default?.createTransport;
      if (!createTransport) {
        throw new Error('createMailer: nodemailer did not expose createTransport');
      }
      return createTransport({
        host: smtpConfig.host,
        port: smtpConfig.port,
        secure: smtpConfig.secure,
        // Gmail requires an app password; a normal account password is rejected.
        ...(smtpConfig.user && smtpConfig.pass
          ? { auth: { user: smtpConfig.user, pass: smtpConfig.pass } }
          : {}),
        connectionTimeout: SEND_TIMEOUT_MS,
        greetingTimeout: SEND_TIMEOUT_MS,
        socketTimeout: SEND_TIMEOUT_MS,
      });
    })();
    return transportPromise;
  }

  return {
    transport: 'smtp',
    async send(message) {
      const transport = await smtpTransport();
      await transport.sendMail({
        from: config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html !== undefined ? { html: message.html } : {}),
      });
    },
  };
}

/** Escape values interpolated into the HTML part of the OTP mail. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

export function otpMail(input: {
  code: string;
  ttlMinutes: number;
  appName?: string;
}): Pick<MailMessage, 'subject' | 'text' | 'html'> {
  const appName = input.appName ?? 'Ultimate Free AI';
  const minutes = Math.max(1, Math.round(input.ttlMinutes));
  const subject = `${input.code} is your ${appName} verification code`;

  return {
    subject,
    text: [
      `Your ${appName} verification code is ${input.code}.`,
      '',
      `It expires in ${minutes} minutes and can be used once.`,
      'If you did not request this, ignore this email — no account was created.',
    ].join('\n'),
    html: [
      `<p>Your ${escapeHtml(appName)} verification code is:</p>`,
      `<p style="font-size:28px;font-weight:700;letter-spacing:6px;font-family:monospace">${escapeHtml(input.code)}</p>`,
      `<p>It expires in ${minutes} minutes and can be used once.</p>`,
      '<p style="color:#666">If you did not request this, ignore this email — no account was created.</p>',
    ].join(''),
  };
}
