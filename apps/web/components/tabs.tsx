import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Icon, type IconName } from './icon'

/**
 * The board's tab strip — one implementation, used by every screen that has
 * one.
 *
 * ## Why this is a component and not a second copy
 *
 * It was drawn for canvas 04 (`Resumo · Documentos · Exigências`) and lived
 * inside `screening-view.tsx`. The Opportunity screen then grew the same need
 * and the tender ended up with two design systems: tabs *after* the AI reading
 * and, before it, a loose "EDITAL E ANEXOS · CRIAR CONTA" block with a bare
 * `.zip` link under the call to action. Sci, on the two screens of the same
 * tender: *"I believe we need to keep the same design system and have the file
 * in the same tabs, not placed surfing anywhere."*
 *
 * So the strip moved here unchanged — same hairline, same 2px blue underline,
 * same 40px stop — and both screens import it. A third screen gets the strip by
 * importing rather than by transcribing it.
 *
 * ## Two kinds of item, because the product has two
 *
 * A **tab** is a `<button>` that swaps the panel below. A **locked** item is a
 * real `<a>` that navigates — the screening screen's "Documentos", which a
 * visitor cannot open at all (§8: files only with an account), so making it
 * selectable would promise a panel that cannot exist. The Opportunity screen
 * needs the opposite: there the Documentos tab *is* selectable and its panel
 * carries the locked state, because a visitor has to be able to see that
 * documents exist before being asked to sign up for them. Both shapes are
 * below; the caller picks by giving an `href` or not.
 *
 * ## The one compromise, stated
 *
 * A `role="tablist"` should own only tabs, and the locked item is a link. It
 * ships that way today and this is a move, not a redesign: calling a link a
 * tab would be the worse lie, and hoisting it out of the strip would put it
 * somewhere else on the screen, which is the defect this component exists to
 * fix. Keyboard behaviour is the manual-activation pattern: every tab is its
 * own Tab stop, Enter and Space activate, no roving tabindex to get wrong.
 *
 * No hooks: the active tab is the caller's state, so a screen renders on the
 * server and its every tab can be asserted with `renderToStaticMarkup`.
 */

export type TabItem<Id extends string = string> = {
  id: Id
  label: ReactNode
  /** Rendered as a link out instead of a tab: it navigates, it never selects. */
  href?: string
  /** Usually the padlock, on an item the current plan cannot open. */
  icon?: IconName
}

/** `radar-tab-items` — the `id` of a tab, and what its panel points back at. */
export function tabId(prefix: string, id: string): string {
  return `${prefix}-tab-${id}`
}

/** `radar-panel-items` — the `id` of the panel a tab controls. */
export function panelId(prefix: string, id: string): string {
  return `${prefix}-panel-${id}`
}

export type TabsProps<Id extends string = string> = {
  items: TabItem<Id>[]
  active: Id
  onSelect?: (id: Id) => void
  /**
   * Namespaces the generated `id`s, so two strips on one page cannot collide
   * and `aria-controls` points at the right panel.
   */
  idPrefix: string
  className?: string
}

const ITEM = 'inline-flex min-h-10 items-center gap-1 border-b-2 px-0.5 text-body'

export function Tabs<Id extends string>({
  items,
  active,
  onSelect,
  idPrefix,
  className,
}: TabsProps<Id>) {
  return (
    <div role="tablist" className={cn('flex gap-5 border-b border-line', className)}>
      {items.map((item) => {
        const icon = item.icon ? <Icon name={item.icon} size={13} /> : null

        if (item.href !== undefined) {
          return (
            <a
              key={item.id}
              href={item.href}
              className={cn(ITEM, 'border-transparent text-muted no-underline')}
            >
              {icon}
              {item.label}
            </a>
          )
        }

        const on = item.id === active
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={tabId(idPrefix, item.id)}
            aria-selected={on}
            aria-controls={panelId(idPrefix, item.id)}
            onClick={onSelect ? () => onSelect(item.id) : undefined}
            className={cn(
              ITEM,
              'border-0 border-b-2 bg-transparent',
              on ? 'border-blue font-semibold text-blue' : 'border-transparent text-muted',
            )}
          >
            {icon}
            {item.label}
          </button>
        )
      })}
    </div>
  )
}

export type TabPanelProps = {
  idPrefix: string
  /** The tab this panel belongs to. */
  id: string
  children: ReactNode
  className?: string
}

/** The panel under the strip, named by its tab so the pair is announced. */
export function TabPanel({ idPrefix, id, children, className }: TabPanelProps) {
  return (
    <div
      role="tabpanel"
      id={panelId(idPrefix, id)}
      aria-labelledby={tabId(idPrefix, id)}
      className={className}
    >
      {children}
    </div>
  )
}
