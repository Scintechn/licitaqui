'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { Button, Card, Field, Select } from '@/components'
import { messages } from '@/lib/messages'
import { radarHref } from '@/lib/radar/client'
import { UF_OPTIONS, normaliseUf } from '@/lib/radar/ufs'

/**
 * The search card of canvas 01 (`Main.dc.html`): CNPJ, the state you deliver
 * to, an optional keyword, and one blue button.
 *
 * It **navigates**; it does not fetch. `POST /api/radar/cnpj` happens on
 * `/radar`, where the "analyzing" state of §3.1 has a screen to live on — see
 * `radar-screen.tsx`. That also keeps this page statically rendered (§3.3) and
 * makes `/radar?cnpj=…&uf=…` a real address the user can bookmark.
 *
 * Without JavaScript the same form still works: it is a real `<form
 * method="get" action="/radar">` whose field names are the query parameters the
 * Radar reads. The submit handler only adds the two checks below and a
 * client-side navigation.
 *
 * ## The one check done here
 *
 * Fourteen digits. The mod-11 check digits are **not** verified here on
 * purpose: `lib/cnpj.ts` owns that rule and imports `node:crypto`, so pulling
 * it into the browser would either fail to bundle or fork the algorithm — and
 * a forked CNPJ validator that drifts from the worker's is how a valid company
 * starts being told its CNPJ is wrong. The API checks it and answers
 * `cnpjInvalid`, which the Radar renders.
 */

const copy = messages.radar.landing
const errors = messages.radar.errors

function digits(value: string): string {
  return value.replace(/\D+/g, '')
}

export function SearchForm() {
  const router = useRouter()
  const [error, setError] = useState<string | undefined>()

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    const data = new FormData(event.currentTarget)
    const cnpj = digits(String(data.get('cnpj') ?? ''))
    const q = String(data.get('q') ?? '').trim()
    const uf = normaliseUf(String(data.get('uf') ?? ''))

    if (!cnpj && !q) {
      event.preventDefault()
      setError(errors.cnpjRequired)
      return
    }
    if (cnpj && cnpj.length !== 14) {
      event.preventDefault()
      setError(errors.cnpjInvalid)
      return
    }

    event.preventDefault()
    setError(undefined)
    router.push(radarHref({ cnpj: cnpj || null, state: uf, q: q || null }))
  }

  return (
    <Card className="flex flex-col gap-3.5">
      <form
        method="get"
        action="/radar"
        noValidate
        aria-label={copy.formLabel}
        onSubmit={handleSubmit}
        className="flex flex-col gap-3.5"
      >
        <Field
          id="cnpj"
          name="cnpj"
          type="text"
          inputMode="numeric"
          maxLength={18}
          mono
          icon="company"
          label={copy.cnpjLabel}
          placeholder={copy.cnpjPlaceholder}
          error={error}
        />

        <Select id="uf" name="uf" label={copy.ufLabel} options={UF_OPTIONS} />

        <Field
          id="q"
          name="q"
          type="search"
          icon="search"
          label={copy.keywordLabel}
          placeholder={copy.keywordPlaceholder}
        />

        <Button type="submit" fullWidth iconEnd="arrowRight">
          {copy.submit}
        </Button>
      </form>
    </Card>
  )
}
