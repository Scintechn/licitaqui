'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { messages } from '@/lib/messages'
import {
  canonicalUfs,
  regionName,
  UF_CODES,
  UF_REGIONS,
  ufLabel,
  ufSummary,
  type Uf,
} from '@/lib/radar/ufs'
import { Icon } from './icon'

/**
 * "UF onde você entrega", for more than one UF (Sci, 2026-10-09).
 *
 * A supplier who delivers to SP, RJ and MG had a `<select>` offering one of them
 * or the whole country. This is a button that says what is chosen — *Todo o
 * Brasil*, *São Paulo (SP)*, *Sudeste*, *MG, RJ e SP*, *… e mais 2* (`ufSummary`)
 * — and opens a panel of checkboxes: *Todo o Brasil*, then the five regions,
 * each heading its own UFs. Ticking a region ticks its UFs; a region with some
 * of them ticked draws as indeterminate.
 *
 * ## Why checkboxes, and why they are named `uf`
 *
 * Both forms that use this are real `GET` forms whose field names are the
 * Radar's query parameters, so they work before React hydrates. A checked box
 * named `uf` posts `uf=SP`, and several post `uf=SP&uf=RJ` — exactly the
 * address `radarHref` writes and `readUfs` reads. So without JavaScript the UF
 * boxes still work; only the region and *Todo o Brasil* shortcuts, which carry
 * no name, need it. A native `<select multiple>` would also post that shape,
 * but asks for Ctrl/⌘-click on a desktop and is hard to use on a phone.
 *
 * ## What it holds
 *
 * The raw set of ticked boxes — **not** collapsed: ticking the last UF of the
 * country must not untick the other 26 under the reader's cursor. The summary
 * and the address collapse it (all 27 is *Todo o Brasil*, `canonicalUfs`).
 *
 * A `<details>` for the same reason `SortMenu` is one: it opens and closes with
 * no JavaScript. With it, a click outside or Escape closes it too.
 *
 * **The panel opens in flow, pushing what is below it down — not over it.**
 * The first version floated it, like `SortMenu`'s list, and it covered the
 * form's own submit button: the browser test's click on *Encontrar editais*
 * landed on a checkbox, and so would a reader's — ticking a UF they never meant
 * to. A menu of three links can float; a panel the reader has to leave to
 * submit cannot.
 */

const BY_NAME = (codes: readonly Uf[]): Uf[] =>
  [...codes].sort((a, b) => ufLabel(a).localeCompare(ufLabel(b), 'pt-BR'))

const REGIONS = UF_REGIONS.map((region) => ({ region, ufs: BY_NAME(region.ufs) }))

export type UfPickerProps = {
  /** Required, not generated, as `Select` and `Field` do. */
  id: string
  label: ReactNode
  /** The UFs ticked on first render. Empty is *Todo o Brasil*. */
  defaultValue?: readonly string[]
  /** Called with the canonical selection whenever it changes. */
  onChange?: (states: string[]) => void
  className?: string
}

export function UfPicker({ id, label, defaultValue = [], onChange, className }: UfPickerProps) {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set(canonicalUfs(defaultValue)))
  const details = useRef<HTMLDetailsElement>(null)
  const labelId = `${id}-label`
  const valueId = `${id}-value`
  const everywhere = ticked.size === 0 || ticked.size === UF_CODES.length

  function update(next: Set<string>) {
    setTicked(next)
    onChange?.(canonicalUfs(next))
  }

  function set(codes: readonly string[], on: boolean) {
    const next = new Set(ticked)
    for (const code of codes) {
      if (on) next.add(code)
      else next.delete(code)
    }
    update(next)
  }

  useEffect(() => {
    function close(event: MouseEvent) {
      const element = details.current
      if (element?.open && !element.contains(event.target as Node)) element.open = false
    }
    function escape(event: KeyboardEvent) {
      const element = details.current
      if (event.key !== 'Escape' || !element?.open) return
      element.open = false
      element.querySelector('summary')?.focus()
    }
    // `click`, not `pointerdown`: the panel is in flow, so closing it on the
    // press collapses it under the cursor and moves whatever was being pressed
    // — the submit button, in the test that found this — before the release.
    document.addEventListener('click', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', escape)
    }
  }, [])

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <span id={labelId} className="text-meta font-medium text-ink">
        {label}
      </span>
      <details ref={details} className="group/uf relative">
        <summary
          id={id}
          aria-labelledby={`${labelId} ${valueId}`}
          className={cn(
            // `Select`'s own box: the 48px height, the radius, the field border
            // and the 16px text — below 16px iOS Safari zooms on focus.
            'flex min-h-control w-full cursor-pointer list-none items-center rounded-control border border-field-line bg-surface',
            'pr-10 pl-3 text-base text-ink [&::-webkit-details-marker]:hidden',
          )}
        >
          <span id={valueId} className="truncate">
            {ufSummary([...ticked])}
          </span>
          <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted">
            <Icon
              name="chevronRight"
              size={18}
              className="rotate-90 transition-transform group-open/uf:-rotate-90"
            />
          </span>
        </summary>
        <fieldset className="mt-1 max-h-80 overflow-y-auto rounded-control border border-line-strong bg-surface py-1">
          <legend className="sr-only">{label}</legend>
          <Row
            label={messages.radar.ufAll}
            checked={everywhere}
            onChange={() => update(new Set())}
            strong
          />
          {REGIONS.map(({ region, ufs }) => {
            const count = ufs.filter((code) => ticked.has(code)).length
            const regionId = `${id}-region-${region.id}`
            return (
              <div key={region.id} role="group" aria-labelledby={regionId} className="border-t border-line pt-1">
                <Row
                  id={regionId}
                  label={regionName(region)}
                  checked={count === ufs.length && !everywhere}
                  indeterminate={count > 0 && count < ufs.length}
                  onChange={(on) => set(ufs, on)}
                  strong
                />
                {ufs.map((code) => (
                  <Row
                    key={code}
                    name="uf"
                    value={code}
                    label={ufLabel(code)}
                    checked={ticked.has(code)}
                    onChange={(on) => set([code], on)}
                    indent
                  />
                ))}
              </div>
            )
          })}
        </fieldset>
      </details>
    </div>
  )
}

function Row({
  id,
  name,
  value,
  label,
  checked,
  indeterminate = false,
  onChange,
  strong = false,
  indent = false,
}: {
  id?: string
  name?: string
  value?: string
  label: string
  checked: boolean
  indeterminate?: boolean
  onChange: (on: boolean) => void
  strong?: boolean
  indent?: boolean
}) {
  const box = useRef<HTMLInputElement>(null)
  // `indeterminate` is a property with no attribute, so it can only be set here.
  useEffect(() => {
    if (box.current) box.current.indeterminate = indeterminate
  }, [indeterminate])

  return (
    <label
      className={cn(
        'flex min-h-touch cursor-pointer items-center gap-3 px-3 text-body text-ink hover:bg-fill-muted',
        indent && 'pl-9',
        strong && 'font-semibold',
      )}
    >
      <input
        ref={box}
        type="checkbox"
        name={name}
        value={value}
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className="size-5 shrink-0 accent-blue"
      />
      <span id={id}>{label}</span>
    </label>
  )
}
