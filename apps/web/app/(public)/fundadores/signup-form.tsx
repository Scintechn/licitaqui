'use client'

import { useEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from 'react'
import { Button, Field, Icon, SectionLabel, StateCard } from '@/components'
import { FOUNDER_SEATS, seatGrid, seatsLeftLabel } from '@/lib/founders'
import type { SeatsResponse, SignupOk, SignupResponse } from '@/lib/founders/contract'
import { format, messages } from '@/lib/messages'

const copy = messages.foundersPage.signup
const form = messages.founders.form
const consent = messages.consent
const errors = messages.founders.errors

/**
 * The founders signup card (task F1), inside the page task D2 ported.
 *
 * It posts to `POST /api/founders`, which assigns the seat in a transaction,
 * and then replaces itself with the confirmation screen: the seat number for
 * founders 1..48, the waitlist place for everyone after them.
 *
 * Two things the page could not do before this task:
 *
 *  - the seat grid is live. The page is statically rendered (spec §3.3), so the
 *    48 cells render empty in the HTML and `GET /api/founders/seats` fills them
 *    in once the browser has the page. A failed or slow count changes nothing
 *    about the form: it still submits, and the transaction is the only thing
 *    that decides whether a seat is left.
 *  - consent is two checkboxes, not one, and neither is pre-ticked — the
 *    wording is Annex B of the terms of use (LGPD art. 8 §4, spec §12): one box
 *    for being contacted, one for accepting the terms and the privacy policy.
 */

/** Catalogue codes the API returns, keyed by the field they belong to. */
type FieldErrors = Record<string, string | undefined>

type FormState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'error'; fields: FieldErrors; message?: string }
  | { kind: 'done'; response: SignupOk; firstName: string }

const ERROR_TEXT: Record<string, string> = {
  nameRequired: errors.nameRequired,
  emailInvalid: errors.emailInvalid,
  whatsappInvalid: errors.whatsappInvalid,
  cnpjInvalid: errors.cnpjInvalid,
  foundersRequired: consent.foundersRequired,
  termsRequired: consent.termsRequired,
}

/**
 * `founders.errors.generic` ends with "escreva para {email}". Until Sci fills
 * `support.email` (its value is still a TODO from task E0), pointing people at
 * a placeholder is worse than the shorter generic line, so we use that instead.
 */
const GENERIC_ERROR = messages.support.email.startsWith('TODO')
  ? messages.errors.generic
  : format(errors.generic, { email: messages.support.email })

function errorText(code: string | undefined): string | undefined {
  if (!code) return undefined
  return ERROR_TEXT[code] ?? GENERIC_ERROR
}

export function SignupForm() {
  const [state, setState] = useState<FormState>({ kind: 'idle' })
  const [taken, setTaken] = useState<number | null>(null)
  const confirmation = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // The live seat count. `AbortController` keeps React's double-invoked
    // effect in development from leaving a request in flight.
    const abort = new AbortController()
    fetch('/api/founders/seats', { signal: abort.signal })
      .then((response) => (response.ok ? (response.json() as Promise<SeatsResponse>) : null))
      .then((seats) => {
        if (seats) setTaken(seats.taken)
      })
      .catch(() => {
        // The count is decoration; the form works without it.
      })
    return () => abort.abort()
  }, [])

  useEffect(() => {
    if (state.kind === 'done') confirmation.current?.focus()
  }, [state.kind])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (state.kind === 'submitting') return

    const data = new FormData(event.currentTarget)
    const body = {
      name: String(data.get('nome') ?? ''),
      email: String(data.get('email') ?? ''),
      whatsapp: String(data.get('whatsapp') ?? ''),
      cnpj: String(data.get('cnpj') ?? ''),
      sells: String(data.get('vende') ?? ''),
      source: sourceFromUrl(),
      contactConsent: data.get('aceite-contato') === 'on',
      acceptedTerms: data.get('aceite-termos') === 'on',
    }

    setState({ kind: 'submitting' })
    try {
      const response = await fetch('/api/founders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = (await response.json()) as SignupResponse

      if (payload.status === 'error') {
        if (payload.error === 'validation' && payload.fields) {
          setState({ kind: 'error', fields: payload.fields })
          return
        }
        setState({
          kind: 'error',
          fields: {},
          message: payload.error === 'rate_limited' ? errors.rateLimited : GENERIC_ERROR,
        })
        return
      }

      setState({ kind: 'done', response: payload, firstName: firstName(body.name) })
    } catch {
      setState({ kind: 'error', fields: {}, message: messages.errors.network })
    }
  }

  if (state.kind === 'done') {
    return (
      <Confirmation response={state.response} firstName={state.firstName} ref={confirmation} />
    )
  }

  const fieldErrors: FieldErrors = state.kind === 'error' ? state.fields : {}
  const busy = state.kind === 'submitting'

  return (
    <form
      id="vaga"
      noValidate
      onSubmit={handleSubmit}
      className={
        'flex flex-col gap-4 rounded-panel border border-line bg-surface p-5 ' +
        'shadow-[0_1px_0_var(--color-line),0_18px_40px_-28px_rgba(23,23,23,0.35)] ' +
        'min-[560px]:p-6'
      }
    >
      <SectionLabel tone="muted" size="caption">
        {copy.planLabel}
      </SectionLabel>

      <div className="flex flex-wrap items-baseline gap-2.5">
        <span className="font-display text-price font-extrabold tracking-[-0.02em] tabular-nums">
          {copy.price}
        </span>
        <span className="text-lead text-muted">{copy.priceUnit}</span>
        <s className="font-mono text-body text-muted">{copy.priceWas}</s>
      </div>
      <p className="-mt-2 text-meta leading-[1.45] text-muted">{copy.priceNote}</p>

      <SeatGauge taken={taken} />

      <Field
        id="nome"
        name="nome"
        type="text"
        autoComplete="name"
        required
        label={form.nameLabel}
        error={errorText(fieldErrors.name)}
      />
      <Field
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        required
        label={form.emailLabel}
        error={errorText(fieldErrors.email)}
      />
      <Field
        id="whatsapp"
        name="whatsapp"
        type="tel"
        autoComplete="tel"
        inputMode="tel"
        required
        placeholder={form.whatsappPlaceholder}
        label={form.whatsappLabel}
        error={errorText(fieldErrors.whatsapp)}
      />
      {/*
        The CNPJ is required (Sci's decision on the card's open question): it is
        what tells the Radar which licitações this business can enter, so the
        founder's list is ready on opening day instead of empty. It is the one
        field the approved HTML does not have.
      */}
      <Field
        id="cnpj"
        name="cnpj"
        type="text"
        inputMode="numeric"
        autoComplete="organization"
        required
        mono
        icon="company"
        placeholder={form.cnpjPlaceholder}
        label={form.cnpjLabel}
        hint={form.cnpjHelp}
        error={errorText(fieldErrors.cnpj)}
      />
      <Field
        id="vende"
        name="vende"
        type="text"
        placeholder={form.sellsPlaceholder}
        label={
          <>
            {form.sellsLabel}{' '}
            <small className="font-normal text-muted">({messages.common.optional})</small>
          </>
        }
      />

      {/*
        LGPD art. 8 §4 and Annex B of the terms: separate, specific, and never
        pre-ticked. `defaultChecked` must never appear on either input.
      */}
      <Consent id="aceite-contato" error={errorText(fieldErrors.contactConsent)}>
        {consent.founders}
      </Consent>
      {/*
        The two documents are links, not words. LGPD art. 8 and CDC art. 46:
        consent is only informed if the person can actually read what they are
        accepting, and a checkbox naming documents it does not reach is worse
        than no checkbox — it records an acceptance that was never possible.
        They open in a new tab so a half-filled form is not lost.
      */}
      <Consent id="aceite-termos" error={errorText(fieldErrors.acceptedTerms)}>
        {consent.termsBefore}
        <a
          href={messages.legal.termsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue underline hover:text-blue-hover"
        >
          {messages.legal.termsLabel.toLocaleLowerCase('pt-BR')}
        </a>
        {consent.termsBetween}
        <a
          href={messages.legal.privacyUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue underline hover:text-blue-hover"
        >
          {messages.legal.privacyLabel.toLocaleLowerCase('pt-BR')}
        </a>
        {consent.termsAfter}
      </Consent>

      {state.kind === 'error' && state.message ? (
        <p role="alert" className="text-meta leading-[1.45] text-error">
          {state.message}
        </p>
      ) : null}

      <Button type="submit" fullWidth iconEnd="arrowRight" disabled={busy} aria-busy={busy}>
        {busy ? form.submitting : messages.founders.offer.cta}
      </Button>

      <p className="text-meta leading-[1.45] text-muted">{copy.note}</p>
      <p className="text-meta leading-[1.45] text-muted">{consent.note}</p>
    </form>
  )
}

/** The 48-cell grid plus the "Restam N vagas" line, once the count arrives. */
function SeatGauge({ taken }: { taken: number | null }) {
  return (
    <div role="group" aria-label={copy.seatsGroup} className="flex flex-col gap-2">
      <div className="flex justify-between text-meta text-muted">
        <span>{copy.seatsLabel}</span>
        <b className="font-mono font-medium text-ink tabular-nums">
          {taken === null ? FOUNDER_SEATS : FOUNDER_SEATS - taken}
        </b>
      </div>
      <div aria-hidden className="grid grid-cols-[repeat(24,minmax(0,1fr))] gap-[3px]">
        {seatGrid(taken ?? 0).map((cell) => (
          <span
            key={cell.seat}
            className={
              'aspect-square max-w-full rounded-[2px] border border-line-strong ' +
              (cell.filled ? 'bg-blue' : 'bg-fill-muted')
            }
          />
        ))}
      </div>
      <p aria-live="polite" className="text-meta leading-[1.45] text-muted">
        {taken === null ? copy.seatsNote : `${seatsLeftLabel(taken)} · ${copy.seatsNote}`}
      </p>
    </div>
  )
}

function Consent({
  id,
  children,
  error,
}: {
  id: string
  children: ReactNode
  error?: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={id}
        className="flex items-start gap-2.5 text-meta leading-[1.4] text-ink-soft"
      >
        <input
          id={id}
          name={id}
          type="checkbox"
          required
          className="mt-px size-5 shrink-0 accent-blue"
        />
        <span>{children}</span>
      </label>
      {error ? <p className="text-meta text-error">{error}</p> : null}
    </div>
  )
}

/* ------------------------------------------------------------ confirmation */

function Confirmation({
  response,
  firstName,
  ref,
}: {
  response: SignupOk
  firstName: string
  ref: Ref<HTMLDivElement>
}) {
  const shell =
    'flex flex-col gap-4 rounded-panel border border-line bg-surface p-5 ' +
    'shadow-[0_1px_0_var(--color-line),0_18px_40px_-28px_rgba(23,23,23,0.35)] ' +
    'min-[560px]:p-6'

  // A repeat signup is not an error and not a second seat: it shows the person
  // where they already are on the list.
  const repeat = response.status === 'already_registered'
  const seat = response.status === 'waitlisted' ? null : response.seat
  const position =
    response.status === 'waitlisted'
      ? response.position
      : response.status === 'already_registered'
        ? response.position
        : null

  return (
    <div
      id="vaga"
      ref={ref}
      tabIndex={-1}
      role="status"
      aria-live="polite"
      className={shell}
    >
      {seat === null ? (
        <>
          <SectionLabel tone="muted" size="caption">
            {messages.founders.seats.soldOut}
          </SectionLabel>
          <h2 className="font-display text-subsection font-bold">
            {messages.founders.waitlist.title}
          </h2>
          {position === null ? null : (
            <p className="text-lead text-ink-soft">
              {format(messages.founders.waitlist.position, { posicao: position })}
            </p>
          )}
          <p className="text-body leading-[1.55] text-ink-soft">
            {messages.founders.waitlist.body}
          </p>
          <p className="text-meta leading-[1.5] text-muted">
            {messages.founders.waitlist.basicNote}
          </p>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2.5">
            <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-pill bg-success">
              <Icon name="check" size={17} strokeWidth={2.6} className="text-surface" />
            </span>
            <h2 className="font-display text-subsection font-bold">
              {format(messages.founders.confirmation.title, { nome: firstName })}
            </h2>
          </div>
          <p className="font-mono text-stat font-medium tabular-nums">
            {format(messages.founders.confirmation.seat, { numero: seat })}
          </p>
          <div className="flex flex-col gap-2">
            <SectionLabel tone="muted" size="caption">
              {messages.founders.confirmation.nextTitle}
            </SectionLabel>
            <ul className="flex flex-col gap-2 text-body leading-[1.5] text-ink-soft">
              {[
                messages.founders.confirmation.nextWhatsapp,
                messages.founders.confirmation.nextOpening,
                messages.founders.confirmation.nextNothing,
              ].map((line) => (
                <li key={line} className="flex items-start gap-2">
                  <Icon name="check" size={18} strokeWidth={2} className="mt-0.5 text-blue" />
                  {line}
                </li>
              ))}
            </ul>
          </div>
          <p className="text-meta leading-[1.5] text-muted">
            {messages.founders.confirmation.share}
          </p>
        </>
      )}

      {repeat ? (
        <StateCard kind="found" title={errors.duplicate} />
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ helpers */

/** `?utm_source=...` — the `source` column of §6.3. Never anything personal. */
function sourceFromUrl(): string | undefined {
  if (typeof window === 'undefined') return undefined
  const value = new URLSearchParams(window.location.search).get('utm_source')
  if (!value) return undefined
  const clean = value.trim().slice(0, 60)
  return /^[\w.-]+$/.test(clean) ? clean : undefined
}

/** "Maria Souza" → "Maria": the confirmation greets people by first name. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? ''
}
