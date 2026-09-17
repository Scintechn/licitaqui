'use client'

import type { FormEvent } from 'react'
import { Button, Field, SectionLabel } from '@/components'
import { FOUNDER_SEATS, seatGrid } from '@/lib/founders'
import { messages } from '@/lib/messages'

const copy = messages.foundersPage.signup
const cta = messages.founders.offer.cta

/**
 * The founders signup card, ported from `paginas/oferta_fundadores.html`.
 *
 * TODO(F1): this form does not submit yet. Task F1 owns `POST /api/founders`,
 * the seat assignment transaction and the confirmation screen (catalogue keys
 * `founders.confirmation.*` / `founders.waitlist.*`), and is blocked on gap G3
 * (privacy policy and terms). Until then the submit handler only cancels the
 * default navigation: nothing is sent, nothing is stored, no seat is taken. The
 * seat grid below is drawn empty for the same reason — the live count comes
 * from `GET /api/founders/seats`, which is also F1.
 */
export function SignupForm() {
  function handleInertSubmit(event: FormEvent<HTMLFormElement>) {
    // TODO(F1): replace with the real submit. Cancelling the default keeps the
    // browser from serialising name, e-mail and WhatsApp into the URL.
    event.preventDefault()
  }

  return (
    <form
      id="vaga"
      noValidate
      onSubmit={handleInertSubmit}
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

      <div role="group" aria-label={copy.seatsGroup} className="flex flex-col gap-2">
        <div className="flex justify-between text-meta text-muted">
          <span>{copy.seatsLabel}</span>
          <b className="font-mono font-medium text-ink tabular-nums">{FOUNDER_SEATS}</b>
        </div>
        <div aria-hidden className="grid grid-cols-[repeat(24,minmax(0,1fr))] gap-[3px]">
          {seatGrid().map((cell) => (
            <span
              key={cell.seat}
              className={
                'aspect-square max-w-full rounded-[2px] border border-line-strong ' +
                (cell.filled ? 'bg-blue' : 'bg-fill-muted')
              }
            />
          ))}
        </div>
        <p className="text-meta leading-[1.45] text-muted">{copy.seatsNote}</p>
      </div>

      <Field
        id="nome"
        name="nome"
        type="text"
        autoComplete="name"
        required
        label={messages.founders.form.nameLabel}
      />
      <Field
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        required
        label={copy.emailLabel}
      />
      <Field
        id="whatsapp"
        name="whatsapp"
        type="tel"
        autoComplete="tel"
        inputMode="tel"
        required
        placeholder={copy.whatsappPlaceholder}
        label={copy.whatsappLabel}
      />
      <Field
        id="vende"
        name="vende"
        type="text"
        placeholder={copy.sellsPlaceholder}
        label={
          <>
            {copy.sellsLabel} <small className="font-normal text-muted">({messages.common.optional})</small>
          </>
        }
      />

      <label
        htmlFor="aceite"
        className="flex items-start gap-2.5 text-meta leading-[1.4] text-ink-soft"
      >
        <input
          id="aceite"
          name="aceite"
          type="checkbox"
          required
          className="mt-px size-5 shrink-0 accent-blue"
        />
        <span>{copy.consent}</span>
      </label>

      <Button type="submit" fullWidth iconEnd="arrowRight">
        {cta}
      </Button>

      <p className="text-meta leading-[1.45] text-muted">{copy.note}</p>
    </form>
  )
}
