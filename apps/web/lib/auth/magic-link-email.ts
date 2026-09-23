import { format, messages } from '@/lib/messages'

/**
 * The magic-link e-mail — subject, body and the call that sends it.
 *
 * ## Why this file exists
 *
 * Until now nothing overrode `sendVerificationRequest`, so `@auth/core` sent
 * its own built-in template: **in English**, headed `Sign in to
 * www.licitaquiapp.com.br`, with no reply-to. On a Brazilian product whose
 * users are MEIs, the first thing a person ever received from us was in a
 * language many of them do not read, from an address that bounces.
 *
 * It stayed invisible because the *page* after the e-mail was broken too
 * (`pages.ts`, 2026-09-23): nobody got far enough to complain about the
 * wording. Fixing the redirect made this the first thing a new founder sees.
 *
 * Copy is `MJ-1a` and `MJ-2` from `docs/NOTIFICATION_JOURNEY.md` §7, approved
 * by Sci. It lives in `messages/pt-BR.json` like every other user-facing
 * string (CLAUDE.md), not inline here.
 *
 * ## Plain text, and both parts
 *
 * No images, no tracking pixel, no remote CSS: a transactional e-mail that
 * asks someone to click a sign-in link should look like one, and anything
 * loaded from a server would be a beacon this product's privacy policy does
 * not declare. Both `text` and `html` are sent — a text-only e-mail lands in
 * spam more often, and an html-only one is unreadable in the clients that
 * strip it.
 *
 * ## A failure must raise
 *
 * If Resend refuses, this throws. Auth.js then shows its error page instead of
 * the "Link enviado" card. That is the whole point: the defect class this
 * repository spent 2026-09-23 fixing is *the app claiming success for
 * something that happened in another channel and did not work*. An e-mail that
 * was never accepted must not render a screen that says it was sent.
 *
 * ## LGPD §12
 *
 * The address and the token are personal data and a credential. Neither is
 * logged, and neither appears in the message this throws — the Resend status
 * and its own error body are enough to debug with, and `identifier` never
 * leaves this function.
 */

/** Brief §1: replies to a sign-in e-mail must reach a mailbox a human reads. */
export const REPLY_TO = 'contato@licitaquiapp.com.br'

const copy = messages.account.signIn.email

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export type MagicLinkEmail = { subject: string; text: string; html: string }

/**
 * The rendered e-mail for one sign-in URL.
 *
 * Exported separately from the sending so the wording can be asserted without
 * a network call, and so a human can read it in a test failure.
 */
export function magicLinkEmail(url: string): MagicLinkEmail {
  const text = [
    copy.heading,
    '',
    copy.intro,
    '',
    url,
    '',
    copy.validity,
    '',
    copy.ignore,
    '',
    format(copy.help, { email: REPLY_TO }),
  ].join('\n')

  const safeUrl = escapeHtml(url)
  const html = `<!doctype html>
<html lang="pt-BR">
  <body style="margin:0;padding:24px;background:#FBF7F3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1C1C1C;">
    <div style="max-width:520px;margin:0 auto;">
      <h1 style="font-size:20px;line-height:1.3;margin:0 0 16px;">${escapeHtml(copy.heading)}</h1>
      <p style="font-size:15px;line-height:1.6;margin:0 0 24px;">${escapeHtml(copy.intro)}</p>
      <p style="margin:0 0 24px;">
        <a href="${safeUrl}" style="display:inline-block;background:#1B4DF5;color:#FFFFFF;text-decoration:none;font-weight:600;font-size:15px;padding:13px 22px;border-radius:10px;">${escapeHtml(copy.button)}</a>
      </p>
      <p style="font-size:14px;line-height:1.6;margin:0 0 16px;color:#4A4A4A;">${escapeHtml(copy.validity)}</p>
      <p style="font-size:14px;line-height:1.6;margin:0 0 16px;color:#4A4A4A;">${escapeHtml(copy.ignore)}</p>
      <p style="font-size:14px;line-height:1.6;margin:0;color:#4A4A4A;">${escapeHtml(format(copy.help, { email: REPLY_TO }))}</p>
      <p style="font-size:12px;line-height:1.6;margin:24px 0 0;color:#6B6B6B;word-break:break-all;">${escapeHtml(copy.fallback)}<br />${safeUrl}</p>
    </div>
  </body>
</html>`

  return { subject: copy.subject, text, html }
}

/** What `sendVerificationRequest` needs from Auth.js. A structural subset. */
export type VerificationRequest = {
  identifier: string
  url: string
  provider: { apiKey?: unknown; from?: unknown }
}

/**
 * Auth.js's `sendVerificationRequest` for the Resend provider.
 *
 * Talks to Resend's REST API directly because overriding this hook replaces
 * the provider's own sending, not just its template.
 */
export async function sendVerificationRequest({
  identifier,
  url,
  provider,
}: VerificationRequest): Promise<void> {
  const { subject, text, html } = magicLinkEmail(url)

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${String(provider.apiKey ?? '')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: String(provider.from ?? ''),
      to: identifier,
      reply_to: REPLY_TO,
      subject,
      text,
      html,
    }),
  })

  if (!response.ok) {
    // No address, no token, no URL in this message (§12). The status and
    // Resend's own body say what went wrong without naming who it was for.
    const detail = await response.text().catch(() => '')
    throw new Error(`Resend refused the magic link: ${response.status} ${detail.slice(0, 200)}`)
  }
}
