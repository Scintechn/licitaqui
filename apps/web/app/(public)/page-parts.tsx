import type { ReactNode } from 'react'
import { SectionLabel } from '@/components'
import { cn } from '@/lib/cn'

/**
 * The layout primitives the approved public pages are built from: one 1120px
 * column, a section rhythm, and the three heading sizes.
 *
 * Both `paginas/landing_radar.html` and `paginas/oferta_fundadores.html` share a
 * stylesheet, so these are transcribed once here. `fundadores/page.tsx` (task
 * D2) declares its own copies inside the file; merging the two is a follow-up
 * for whoever touches that page next — doing it from this lane would collide
 * with the legal-pages lane, which is editing that file's footer.
 */

/** `.wrap` — one 1120px column with the 20px gutter. */
export function Wrap({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-[1120px] px-gutter', className)}>{children}</div>
}

/**
 * `section` — the public pages' vertical rhythm, and the page's density dial.
 *
 * The board drew 48px on a phone and 64px from 560px up. Measured on
 * `/fundadores` at 1280px that is 288px of the page's 5909px spent on the air
 * *between* sections — 4.9% of the document, across nine of them — while the
 * signup card beside the hero is comparatively tight. Sci asked the page to
 * read closer to that card, so the rhythm steps down to 40/48.
 *
 * It is deliberately the one place the change is made: every public section
 * inherits it, so the rhythm stays even and the diff stays reviewable. Air
 * *inside* a block (body line-height, `SectionHead`'s own gap, touch targets,
 * the 20px gutter) is untouched — the air worth reclaiming is between blocks,
 * not within them.
 */
export function Section({
  children,
  divided = true,
  className,
  ...rest
}: {
  children: ReactNode
  /** `.borda-topo` — the rule separating this section from the one above. */
  divided?: boolean
  className?: string
  id?: string
  'aria-label'?: string
}) {
  return (
    <section
      {...rest}
      className={cn('py-10 min-[560px]:py-12', divided && 'border-t border-line', className)}
    >
      {children}
    </section>
  )
}

export function H2({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h2
      className={cn(
        'font-display text-section font-bold tracking-[-0.01em] text-balance',
        className,
      )}
    >
      {children}
    </h2>
  )
}

export function H3({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h3
      className={cn(
        'font-display text-subsection font-bold tracking-[-0.01em] text-balance',
        className,
      )}
    >
      {children}
    </h3>
  )
}

/** `.secao-cab` — eyebrow, heading and an optional standfirst, max 720px wide. */
export function SectionHead({
  label,
  title,
  children,
  className,
}: {
  label: string
  title: string
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex max-w-[720px] flex-col gap-3', className)}>
      <SectionLabel tone="muted" size="caption">
        {label}
      </SectionLabel>
      <H2>{title}</H2>
      {children}
    </div>
  )
}

/**
 * A white public-page panel: radius 14 rather than the app's 12, and a blue
 * 2px edge when it is the one being recommended.
 *
 * Not `<Card>`: `lib/cn.ts` is a plain join, so a caller's `rounded-panel` and
 * `border-2 border-blue` would sit in the class list next to the component's
 * own `rounded-card` and `border-line` and the winner would be decided by
 * stylesheet order rather than by the caller. A closed variant here instead.
 */
export function Panel({
  children,
  accent = false,
  className,
}: {
  children: ReactNode
  accent?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        'rounded-panel bg-surface',
        accent ? 'border-2 border-blue' : 'border border-line',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** `.fonte` — the provenance line under an example or a figure. */
export function Source({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('text-caption leading-[1.55] text-muted', className)}>{children}</p>
}
