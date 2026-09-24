'use client'

import { useEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from 'react'
import { Button, Field, Icon, SectionLabel, StateCard } from '@/components'
import { FOUNDER_SEATS, seatGrid, seatsLeftLabel, showSeatGrid } from '@/lib/founders'
import type { SeatsResponse, SignupOk, SignupResponse } from '@/lib/founders/contract'
import { format, messages } from '@/lib/messages'
import { ShareSeat } from './share-seat'

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
 *    HTML carries no cells at all and `GET /api/founders/seats` decides whether
 *    there are any to draw — see `showSeatGrid()`. A failed or slow count
 *    changes nothing about the form: it still submits, and the transaction is
 *    the only thing that decides whether a seat is left.
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

/**
 * A finished signup. It is **not** state of this component any more — see
 * `SignupForm`'s props and the docstring on `signup-sheet.tsx`.
 */
export type SignupDone = { response: SignupOk; firstName: string }

/**
 * The fields in the order they are on screen, and the control that owns each.
 *
 * Both halves are needed and neither is derivable from the other: the API
 * answers in *its* field names (`lib/founders/input.ts`) and the inputs carry
 * Portuguese ids, so "the first error" can only be resolved by walking the
 * screen order and then looking the control up. `vende` is absent because
 * nothing can fail there.
 */
const FIELD_ORDER = [
  'name',
  'email',
  'whatsapp',
  'cnpj',
  'contactConsent',
  'acceptedTerms',
] as const

const INPUT_ID: Record<(typeof FIELD_ORDER)[number], string> = {
  name: 'nome',
  email: 'email',
  whatsapp: 'whatsapp',
  cnpj: 'cnpj',
  contactConsent: 'aceite-contato',
  acceptedTerms: 'aceite-termos',
}

/**
 * The card the form and the confirmation are both drawn on.
 *
 * One constant, used by both, because the confirmation **replaces the form in
 * place**: any difference between the two is a visible jump at the moment
 * somebody has just handed over their details. They were two identical string
 * literals with a comment asking the next person to keep them in step, which
 * is the kind of instruction that survives exactly one edit.
 *
 * Below 560px it is not a card at all. The sheet is the screen there, so a
 * radius, a hairline and a 40px shadow were being drawn flush against the
 * phone's edge, inside a panel, inside a `px-3` wrapper — a card in a card,
 * and a 324px measure on a 390px screen, which is *narrower* than the same
 * form had when it was a section of the page. From 560px up the sheet is a
 * centred card floating on the scrim and every one of them earns its place.
 */
const PANEL =
  'flex flex-col gap-4 bg-surface min-[560px]:rounded-panel min-[560px]:border ' +
  'min-[560px]:border-line min-[560px]:p-6 ' +
  'min-[560px]:shadow-[0_1px_0_var(--color-line),0_18px_40px_-28px_rgba(23,23,23,0.35)]'

const ERROR_TEXT: Record<string, string> = {
  nameRequired: errors.nameRequired,
  emailInvalid: errors.emailInvalid,
  whatsappInvalid: errors.whatsappInvalid,
  cnpjInvalid: errors.cnpjInvalid,
  foundersRequired: consent.foundersRequired,
  termsRequired: consent.termsRequired,
}

/**
 * `founders.errors.generic` ends with "escreva para {email}". That is support,
 * not a data-subject request, so it names `contato@` (legal brief §1). The E0
 * `TODO(Sci)` placeholder that used to force the shorter generic line is gone.
 */
const GENERIC_ERROR = format(errors.generic, { email: messages.support.email })

function errorText(code: string | undefined): string | undefined {
  if (!code) return undefined
  return ERROR_TEXT[code] ?? GENERIC_ERROR
}

/**
 * @param done  The finished signup, held by `SignupSheet` — see there for why.
 *              Non-null renders the confirmation instead of the form.
 * @param onDone Called once, with the seat, when the API accepts the signup.
 */
export function SignupForm({
  done,
  onDone,
}: {
  done: SignupDone | null
  onDone: (done: SignupDone) => void
}) {
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
    if (done) confirmation.current?.focus()
  }, [done])

  /**
   * **Take the reader to the error.** This was the live defect on 2026-09-24.
   *
   * At 390px this form is about one and a half screens tall, and the submit is
   * at the bottom — which is where somebody is standing when the answer comes
   * back. A rejected e-mail address renders its message roughly 530px *above*
   * the viewport, and before this nothing moved: the only thing that changed
   * where the reader was looking was the button reverting from "Guardando sua
   * vaga…" to its idle label, which reads as *nothing happened*. People press
   * it again, and again, and eventually leave — on the page taking sign-ups.
   *
   * Three things had to be true at once for it to be invisible, and they were:
   * `noValidate` (deliberate, and it switches off the browser's own
   * scroll-into-view for an invalid control), no scroll of ours, and a message
   * that announces nothing — `Field` renders it as a bare `<p>`, correctly
   * wired to the input through `aria-describedby`, which a screen reader only
   * reads out when the **input** takes focus.
   *
   * So the fix is to focus the control rather than the message: one move
   * satisfies all three — `aria-describedby` announces the error, the panel
   * scrolls, and a sighted keyboard user is left on the field they have to
   * correct. `Field` deliberately does **not** also get an `aria-live` region;
   * with the focus move it would announce the same sentence twice.
   *
   * Field-level errors only. A form-level `state.message` already carries
   * `role="alert"` and renders immediately above the submit, which is where
   * the reader is, so moving focus for it would take somebody away from a
   * message they are already looking at.
   */
  useEffect(() => {
    if (state.kind !== 'error') return
    const field = FIELD_ORDER.find((name) => state.fields[name])
    if (!field) return
    const control = document.getElementById(INPUT_ID[field])
    if (!control) return
    // `preventScroll`, then centre it by hand: the browser's own scroll on
    // focus is "nearest", which parks an error message one line inside the
    // bottom edge of the panel, under the thumb.
    control.focus({ preventScroll: true })
    control.scrollIntoView({ block: 'center' })
  }, [state])

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

      onDone({ response: payload, firstName: firstName(body.name) })
    } catch {
      setState({ kind: 'error', fields: {}, message: messages.errors.network })
    }
  }

  if (done) {
    return <Confirmation response={done.response} firstName={done.firstName} ref={confirmation} />
  }

  const fieldErrors: FieldErrors = state.kind === 'error' ? state.fields : {}
  const busy = state.kind === 'submitting'

  return (
    <form noValidate onSubmit={handleSubmit} className={PANEL}>
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

      {/*
        The 30-day guarantee, next to the price rather than buried in the FAQ.
        It is contractual (terms §8) and it is a reason to subscribe, not fine
        print — and until today it appeared nowhere in the product at all, while
        `faq-cobranca.md` said the Offer must carry it.
      */}
      <p className="-mt-1 flex items-start gap-2 text-meta leading-[1.45] text-ink-soft">
        <Icon name="check" size={16} strokeWidth={2} className="mt-0.5 shrink-0 text-blue" />
        {messages.foundersPage.refunds.ctaLine}
      </p>

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
        The CNPJ is **optional** (Sci, 2026-09-24, reversing the earlier call).

        It was required because it is what makes the founder's Radar list ready
        on opening day rather than empty — a good reason to *ask*, and not a
        good enough one to *refuse the signup without it*. This form is the top
        of the funnel: fourteen digits somebody has to go and look up, on a page
        that has not yet asked for a single cruzeiro, is the most expensive
        field here. Somebody who leaves rather than fetch their CNPJ costs the
        whole lead; somebody who joins without it costs one lookup later.

        `founders_list.cnpj` was already nullable, so nothing in the schema had
        to change for this — only the two places that insisted.

        The hint still says what it is for, so the reason to fill it in is on
        screen even though the obligation is gone.
      */}
      <Field
        id="cnpj"
        name="cnpj"
        type="text"
        inputMode="numeric"
        autoComplete="organization"
        maxLength={18}
        mono
        icon="company"
        placeholder={form.cnpjPlaceholder}
        label={
          <>
            {form.cnpjLabel}{' '}
            <small className="font-normal text-muted">({messages.common.optional})</small>
          </>
        }
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

/**
 * The "Restam N vagas" line, and the 48-cell grid once there is a seat in it.
 *
 * The grid is conditional — see `showSeatGrid()` for why. The count and the
 * sentence are not: they are true at 0 taken ("Restam 48 vagas") and at 48
 * ("Vagas esgotadas"), and they are the part that does the work. The grid is
 * the part that only helps once it has something to show.
 */
function SeatGauge({ taken }: { taken: number | null }) {
  return (
    <div role="group" aria-label={copy.seatsGroup} className="flex flex-col gap-2">
      <div className="flex justify-between text-meta text-muted">
        <span>{copy.seatsLabel}</span>
        <b className="font-mono font-medium text-ink tabular-nums">
          {taken === null ? FOUNDER_SEATS : FOUNDER_SEATS - taken}
        </b>
      </div>
      {showSeatGrid(taken) ? (
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
      ) : null}
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
          className="mt-px size-6 shrink-0 accent-blue"
        />
        <span>{children}</span>
      </label>
      {error ? <p className="text-meta text-error">{error}</p> : null}
    </div>
  )
}

/* ------------------------------------------------------------ confirmation */

/**
 * Whether the confirmation may say a WhatsApp message was already sent.
 *
 * **It may not, and this is why.** `founders.confirmation.nextWhatsapp` reads
 * *"Mandamos uma mensagem no seu WhatsApp confirmando a vaga."* — past tense,
 * a statement that something has happened. Nothing has. The signup does queue
 * the job (`lib/founders/signup.ts` writes `kind = 'send_whatsapp'` in the
 * same statement that assigns the seat) and the worker does register a handler
 * for it, but `WHATSAPP_DELIVERY` gates the transport and **only the exact
 * word `send` opens it** (`worker/licitaqui/evolution.py`). With the switch
 * off the job runs every gate, renders the message, writes a
 * `whatsapp.dry_run` event and finishes `done` — so the queue, the job status
 * and the delivery log all look healthy and no message leaves the process.
 * Sci signed up on production on 2026-09-24 and received nothing.
 *
 * The switch is off **deliberately** and cannot simply be flipped:
 * `worker/README.md` records that the only Evolution instance on the server
 * belongs to another product (`flowdeski-scn-real-estate`), so turning it on
 * today would deliver LicitaQui's founders welcome from that product's
 * WhatsApp number.
 *
 * `/fundadores` takes money, so the sentence is a binding representation under
 * CDC art. 30 — the same defect class as the "todo dia" alert claim. The copy
 * is Sci's under legal brief §5, so it is **not rewritten here**: the string
 * stays in the catalogue untouched and this stops rendering it, which is a
 * rendering decision and within what this change may make.
 *
 * **Flip this to `true` in the same PR that proves a message arrives** — card
 * E4 in `docs/DEVELOPMENT_PLAN.md` §5. It is one token. `signup-form.test.tsx`
 * covers **both** settings of it, so the `true` branch is not untested code
 * waiting to be discovered on the day; what will go red is the browser
 * assertion in `fundadores.spec.ts` that the sentence is absent, and E4's
 * acceptance criteria say to invert it rather than delete it.
 */
/**
 * **Proven on 2026-09-24, so the sentence is true and renders again.**
 *
 * Sci set the four Evolution variables on the worker container and redeployed.
 * Job `84044` (`send_whatsapp`, `founders:1`) then ran once and wrote
 * `whatsapp.sent` with `status: 201` and a real `message_id`, and the message
 * arrived on his handset at 21:51 BRT with the right name, seat and price.
 *
 * The evidence that matters is the **event**, not the job row — and not
 * `WHATSAPP_DELIVERY` being set, which is configuration rather than proof.
 * Turning this back to `false` is the correct move if delivery ever stops:
 * the page must never claim a message it did not send (CDC art. 30).
 */
const WHATSAPP_WELCOME_IS_DELIVERED: boolean = true

/**
 * "O que acontece agora", minus anything that is not true yet.
 *
 * `nextOpening` and `nextNothing` both stay: the first is a promise about
 * 08/10 which S3 still owns and has not broken, the second is a statement
 * about the reader. Only `nextWhatsapp` claims a past event that did not
 * happen.
 */
export function nextSteps(delivered: boolean = WHATSAPP_WELCOME_IS_DELIVERED): string[] {
  const steps = [
    messages.founders.confirmation.nextOpening,
    messages.founders.confirmation.nextNothing,
  ]
  return delivered ? [messages.founders.confirmation.nextWhatsapp, ...steps] : steps
}

function Confirmation({
  response,
  firstName,
  ref,
}: {
  response: SignupOk
  firstName: string
  ref: Ref<HTMLDivElement>
}) {
  // No `id` and no scroll offset: this branch replaces the form *inside the
  // dialog*, which is already in view and already holds focus. Both existed
  // for `#vaga`, which no longer exists.
  //
  // The card itself is `PANEL`, the same constant the form uses — it replaces
  // the form in place, so the two cannot be allowed to drift apart.

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
      ref={ref}
      tabIndex={-1}
      role="status"
      aria-live="polite"
      /*
        `role="status"` carries an implicit `aria-atomic="true"`, which was
        harmless while nothing in here ever changed. The share control's label
        does change — "Copiar" → "Copiado", and back 2.4 s later — and atomic
        would re-read the *entire* confirmation each time: the greeting, the
        seat, both bullets, the share sentence and the whole URL, twice per
        press. Explicitly false, so only the label that changed is announced.
      */
      aria-atomic="false"
      className={PANEL}
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
          {/*
            The good news first and loudest. It used to be the *second* thing
            here by size: the seat sat under it at `text-stat` (34px) in the
            mono face, 70% larger than the heading above it, which made the
            number the announcement and "Vaga garantida" its caption. Sci,
            2026-09-24: "doesn't matter what number in the process you are, the
            1st or 13th." Mono at that size reads as a system readout, not as
            good news.
          */}
          <div className="flex items-center gap-2.5">
            <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-pill bg-success">
              <Icon name="check" size={17} strokeWidth={2.6} className="text-surface" />
            </span>
            <h2 className="font-display text-subsection font-bold">
              {format(messages.founders.confirmation.title, { nome: firstName })}
            </h2>
          </div>

          {/*
            The seat stays, quietly — it is still true and somebody will want
            it. Body face, not mono; `tabular-nums` is kept because it is a
            figure, and that is the whole of the typographic claim being made
            for it now.
          */}
          <p className="-mt-2 text-meta leading-[1.45] text-muted tabular-nums">
            {format(messages.founders.confirmation.seat, { numero: seat })}
          </p>

          <div className="flex flex-col gap-2">
            <SectionLabel tone="muted" size="caption">
              {messages.founders.confirmation.nextTitle}
            </SectionLabel>
            <ul className="flex flex-col gap-2 text-body leading-[1.5] text-ink-soft">
              {nextSteps().map((line) => (
                <li key={line} className="flex items-start gap-2">
                  <Icon name="check" size={18} strokeWidth={2} className="mt-0.5 text-blue" />
                  {line}
                </li>
              ))}
            </ul>
          </div>

          {/* `confirmation.share` asks the reader to pass it on; this is what
              they pass it on *with*. See `share-seat.tsx`. */}
          <ShareSeat />
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
