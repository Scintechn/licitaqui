import type { ReactNode, SelectHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'
import { Icon } from './icon'

/**
 * The board's third control, next to `Field` and `Button`: the "UF onde você
 * entrega" picker on canvas 01 (`Main.dc.html`) and the Radar's state filter.
 *
 * Added by task D3 rather than inlined in the two screens that need it, so the
 * select and the text field cannot drift apart — they share the 48px height,
 * the 8px radius, the field border and, most importantly, the 16px text size:
 * **iOS Safari zooms the whole viewport when a focused control renders below
 * 16px**, and a form whose input is 16px and whose select is 15px throws the
 * layout around the moment the user taps the second one (task F1 fixed exactly
 * this on `Field`; the same rule applies here).
 *
 * A real `<select>`, not a listbox made of divs: it gets the platform picker on
 * a phone, keyboard behaviour and screen-reader semantics for nothing. The
 * native arrow is replaced by the board's `chevronRight` rotated a quarter
 * turn, because the platform one differs between browsers.
 */

export type SelectOption = {
  value: string
  label: string
}

export type SelectProps = Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'className' | 'id' | 'children'
> & {
  /** Required, not generated: keeps this a Server Component, as `Field` is. */
  id: string
  label: ReactNode
  options: SelectOption[]
  hint?: ReactNode
  error?: ReactNode
  className?: string
}

export function Select({
  id,
  label,
  options,
  hint,
  error,
  className,
  ...select
}: SelectProps) {
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ')

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-meta font-medium text-ink">
        {label}
      </label>

      <div className="relative">
        <select
          {...select}
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={cn(
            'min-h-control w-full appearance-none rounded-control border bg-surface',
            // 16px for the same reason `Field` is 16px. Do not "correct" it.
            'pr-10 pl-3 text-base text-ink',
            error ? 'border-error' : 'border-field-line',
          )}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted">
          <Icon name="chevronRight" size={18} className="rotate-90" />
        </span>
      </div>

      {error ? (
        <p id={errorId} className="text-meta text-error">
          {error}
        </p>
      ) : null}
      {hint ? (
        <p id={hintId} className="text-meta text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
