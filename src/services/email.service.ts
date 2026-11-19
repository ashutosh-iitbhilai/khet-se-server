import { env } from '../config/env';
import { logger } from '../utils/logger';

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Emails "sent" with the log provider under NODE_ENV=test, for assertions. */
export const testOutbox: Email[] = [];

/** "Khet Se <no-reply@khetse.in>" → { name, email } */
function parseFrom(from: string) {
  const m = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? { name: m[1] || undefined, email: m[2] } : { name: undefined, email: from.trim() };
}

const TIMEOUT_MS = 10_000;

async function post(url: string, headers: Record<string, string>, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Email provider responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/**
 * Sends one transactional email through the configured provider (plain HTTPS, no SMTP).
 * Throws on failure; callers decide whether that should reach the user.
 */
export async function sendEmail(mail: Email): Promise<void> {
  switch (env.EMAIL_PROVIDER) {
    case 'resend':
      return post('https://api.resend.com/emails', { Authorization: `Bearer ${env.EMAIL_API_KEY}` }, {
        from: env.EMAIL_FROM,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
    case 'brevo': {
      const from = parseFrom(env.EMAIL_FROM);
      return post('https://api.brevo.com/v3/smtp/email', { 'api-key': env.EMAIL_API_KEY }, {
        sender: { name: from.name ?? 'Khet Se', email: from.email },
        to: [{ email: mail.to }],
        subject: mail.subject,
        textContent: mail.text,
        htmlContent: mail.html,
      });
    }
    default:
      if (env.NODE_ENV === 'test') {
        testOutbox.push(mail);
      } else if (env.NODE_ENV === 'production') {
        // Never write reset links into production logs.
        logger.warn(`Email not sent (EMAIL_PROVIDER=log): "${mail.subject}"`);
      } else {
        logger.info(`📧 Email to ${mail.to} — ${mail.subject}\n${mail.text}`);
      }
  }
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Minimal, client-safe layout: one column, inline styles, square button. */
export function layout(opts: { heading: string; paragraphs: string[]; button?: { label: string; url: string }; footer?: string }) {
  const p = (t: string) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:#3b2f24">${escape(t)}</p>`;
  const button = opts.button
    ? `<p style="margin:24px 0"><a href="${escape(opts.button.url)}" style="display:inline-block;background:#2f6b2f;color:#ffffff;text-decoration:none;padding:12px 22px;font-weight:600;font-size:15px">${escape(opts.button.label)}</a></p>
       <p style="margin:0 0 16px;font-size:13px;color:#7a6a5a">Or paste this link into your browser:<br><span style="word-break:break-all">${escape(opts.button.url)}</span></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f7f3ea;font-family:Arial,Helvetica,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border:1px solid #e4dccb" cellpadding="0" cellspacing="0">
      <tr><td style="background:#2f6b2f;padding:16px 24px;color:#ffffff;font-size:18px;font-weight:700">Khet Se</td></tr>
      <tr><td style="padding:28px 24px">
        <h1 style="margin:0 0 16px;font-size:20px;color:#3b2f24">${escape(opts.heading)}</h1>
        ${opts.paragraphs.map(p).join('')}
        ${button}
        ${opts.footer ? `<p style="margin:24px 0 0;font-size:12px;color:#7a6a5a">${escape(opts.footer)}</p>` : ''}
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
}
