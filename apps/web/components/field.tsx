import type { InputHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Icon, type IconName } from './icon'

export type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'id'> & {
  /**
   * Required, not generated: this keeps Field a Server Component (no `useId`,
   * no `'use client'`, no JavaScript shipped for a plain text input).
   */
  id: string
  label: ReactNode
  /** Helper text under the field. Announced through `aria-describedby`. */
  hint?: ReactNode
  /** Error text. Replaces the hint, turns the border red and sets `aria-invalid`. */
  error?: ReactNode
  /** Trailing icon inside the field, as on the board's CNPJ field. */
  icon?: IconName
  /** Monospace input for CNPJ, codes and figures — the board's "dados" face. */
  mono?: boolean
  className?: string
}

export function Field({
  id,
  label,
  hint,
  error,
  icon,
  mono = false,
  className,
  ...input
}: FieldProps) {
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy = [error ? errorId : null, hint ? hintId : null]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-meta font-medium text-ink">
        {label}
      </label>

      <div className="relative">
        <input
          {...input}
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={cn(
            // 16px, not the board's 15px (`text-lead`), and deliberately so:
            // iOS Safari zooms the whole viewport when a focused input renders
            // below 16px, which on a public page most people open from a phone
            // throws the layout around mid-form. Do not "correct" this back.
            'min-h-control w-full rounded-control border bg-surface pl-3 text-base text-ink',
            'placeholder:text-muted',
            icon ? 'pr-10' : 'pr-3',
            mono ? 'font-mono' : 'font-sans',
            error ? 'border-error' : 'border-field-line',
          )}
        />
        {icon ? (
          <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted">
            <Icon name={icon} size={18} />
          </span>
        ) : null}
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
