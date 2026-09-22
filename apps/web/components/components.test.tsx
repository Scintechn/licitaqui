import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AppBarAction,
  Button,
  Field,
  Icon,
  LockedValue,
  Logo,
  SectionLabel,
  Select,
  StateCard,
  Status,
  TabPanel,
  Tabs,
  Tag,
  panelId,
  tabId,
  type TabItem,
} from './index'

const html = (node: React.ReactNode) => renderToStaticMarkup(node)

describe('Button', () => {
  it('renders a real <button> with an explicit type by default', () => {
    const out = html(<Button>Enviar</Button>)
    expect(out).toContain('<button')
    expect(out).toContain('type="button"')
    expect(out).not.toContain('<a ')
  })

  it('renders a real <a> when href is given, and never a button', () => {
    const out = html(<Button href="/conta/criar">Criar conta</Button>)
    expect(out).toContain('href="/conta/criar"')
    expect(out).toContain('<a ')
    expect(out).not.toContain('<button')
  })

  it('keeps submit buttons submitting', () => {
    expect(html(<Button type="submit">Salvar</Button>)).toContain('type="submit"')
  })

  it('gives the locked variant a padlock without being disabled', () => {
    const out = html(<Button variant="locked">Travado</Button>)
    expect(out).toContain('border-dashed')
    expect(out).toContain(html(<Icon name="locked" size={16} />))
    // The `disabled:` utilities are in the class list; the attribute must not be.
    expect(out).not.toMatch(/\sdisabled(=|\s|>)/)
  })

  it('lets an explicit iconStart win over the locked default', () => {
    const locked = html(<Icon name="locked" size={16} />)
    const margin = html(<Icon name="margin" size={16} />)
    const out = html(
      <Button variant="locked" iconStart="margin">
        Preço
      </Button>,
    )
    expect(out).toContain(margin)
    expect(out).not.toContain(locked)
  })

  it('only stretches when asked to', () => {
    expect(html(<Button>a</Button>)).not.toContain('w-full')
    expect(html(<Button fullWidth>a</Button>)).toContain('w-full')
  })
})

describe('Field', () => {
  it('ties the label to the input', () => {
    const out = html(<Field id="cnpj" label="CNPJ da empresa" />)
    expect(out).toContain('for="cnpj"')
    expect(out).toContain('id="cnpj"')
  })

  it('describes the input with its hint', () => {
    const out = html(<Field id="uf" label="UF" hint="Sigla de duas letras" />)
    expect(out).toContain('aria-describedby="uf-hint"')
    expect(out).toContain('id="uf-hint"')
  })

  it('marks an errored input invalid and points at both messages', () => {
    const out = html(<Field id="uf" label="UF" hint="Sigla" error="Use duas letras" />)
    expect(out).toContain('aria-invalid="true"')
    expect(out).toContain('aria-describedby="uf-error uf-hint"')
    expect(out).toContain('border-error')
  })

  it('omits aria-describedby when there is nothing to describe', () => {
    expect(html(<Field id="q" label="Busca" />)).not.toContain('aria-describedby')
  })

  it('reserves room for the trailing icon only when there is one', () => {
    expect(html(<Field id="a" label="A" icon="company" />)).toContain('pr-10')
    expect(html(<Field id="a" label="A" />)).toContain('pr-3')
  })
})

describe('Icon', () => {
  it('is hidden from assistive tech unless it is given a name', () => {
    expect(html(<Icon name="alert" />)).toContain('aria-hidden="true"')
    const titled = html(<Icon name="alert" title="Alertas" />)
    expect(titled).toContain('role="img"')
    expect(titled).toContain('aria-label="Alertas"')
    expect(titled).not.toContain('aria-hidden')
  })

  it('draws on the board grid at the board stroke', () => {
    const out = html(<Icon name="tender" />)
    expect(out).toContain('viewBox="0 0 24 24"')
    expect(out).toContain('stroke-width="1.8"')
  })
})

describe('Logo', () => {
  it('keeps the staggered bar geometry from the brand spec', () => {
    const out = html(<Logo />)
    expect(out).toContain('x="34" y="12" width="22" height="11"')
    expect(out).toContain('x="8" y="27" width="48" height="11"')
    expect(out).toContain('x="14" y="42" width="42" height="11"')
  })

  it('reads as "LicitaQui" once, with only Qui in blue', () => {
    const out = html(<Logo />)
    expect(out).toContain('aria-label="LicitaQui"')
    // The wordmark is outlines now, so "Qui" is a path and not a text node.
    // Its tone is still the one thing that must never drift: two paths, one
    // ink, one blue, and the accessible name carried by the wrapper alone.
    expect(out.match(/<path /g)).toHaveLength(2)
    expect(out).toContain('class="fill-ink"></path>')
    expect(out).toContain('class="fill-blue"></path>')
  })

  it('scales the wordmark with the symbol, and never sets type to do it', () => {
    // The old assertion was `font-size:22px` / `font-stretch:85%`. Both are
    // gone with the live text: the wordmark is an SVG whose box is the box the
    // text used to occupy — height = round(size * 0.733), width in the same
    // ratio as the shaped advance (3731/1000 em).
    expect(html(<Logo size={30} />)).toContain('height="22"')
    expect(html(<Logo size={60} />)).toContain('height="44"')
    expect(html(<Logo size={30} />)).toContain('width="82.082"')
    expect(html(<Logo />)).toContain('viewBox="0 -834 3731 1000"')

    // The width axis is what this change exists to stop loading (fonts.ts).
    // If anything reintroduces `font-stretch` here, Archivo has to carry wdth
    // again and the 90KB comes back.
    expect(html(<Logo />)).not.toContain('font-stretch')
    expect(html(<Logo />)).not.toContain('font-size')
  })

  it('never puts blue on blue: the ivory tone paints bars and wordmark ivory', () => {
    const out = html(<Logo tone="ivory" />)
    expect(out).not.toContain('fill-blue')
    // Three bars plus the two wordmark paths.
    expect(out.match(/fill-ivory/g)).toHaveLength(5)
  })

  it('keeps the light-blue accent for dark backgrounds only', () => {
    expect(html(<Logo tone="inverse" />)).toContain('fill-blue-light')
  })

  it('drops the wordmark for the symbol variant but keeps the name', () => {
    const out = html(<Logo variant="symbol" />)
    expect(out).toContain('aria-label="LicitaQui"')
    expect(out).not.toContain('Qui</span>')
  })
})

describe('Status and Tag', () => {
  it('pairs every status colour with a text label', () => {
    const out = html(<Status kind="check">Verificar</Status>)
    expect(out).toContain('Verificar')
    expect(out).toContain('bg-attention-soft')
  })

  it('hides the decorative dot from assistive tech', () => {
    expect(html(<Status kind="compatible">Compatível</Status>)).toContain('aria-hidden="true"')
  })

  it('defaults a tag to the neutral tone', () => {
    expect(html(<Tag>Cota ME/EPP</Tag>)).toContain('bg-surface')
    expect(html(<Tag tone="blue">Exclusivo</Tag>)).toContain('bg-blue-soft')
  })
})

describe('StateCard', () => {
  it('announces the analyzing state politely', () => {
    const out = html(<StateCard kind="analyzing" title="Analisando edital…" />)
    expect(out).toContain('role="status"')
    expect(out).toContain('aria-live="polite"')
  })

  it('does not turn settled states into live regions', () => {
    expect(html(<StateCard kind="empty" title="Nada agora" />)).not.toContain('aria-live')
  })

  it('colours only the found and limit titles', () => {
    expect(html(<StateCard kind="found" title="Achou" />)).toContain('text-success')
    expect(html(<StateCard kind="limit" title="Limite" />)).toContain('text-attention')
    expect(html(<StateCard kind="empty" title="Nada" />)).toContain('text-ink')
  })
})

describe('LockedValue', () => {
  it('is invisible to screen readers with no label', () => {
    expect(html(<LockedValue />)).toContain('aria-hidden="true"')
  })

  it('becomes an image with a label when the screen supplies one', () => {
    const out = html(<LockedValue label="Disponível no plano Essencial" />)
    expect(out).toContain('role="img"')
    expect(out).toContain('aria-label="Disponível no plano Essencial"')
  })
})

describe('AppBarAction', () => {
  it('names its icon-only target and keeps a 44px touch area', () => {
    const out = html(<AppBarAction icon="alert" label="Alertas" />)
    expect(out).toContain('aria-label="Alertas"')
    expect(out).toContain('size-touch')
  })
})

/* What task D2 added to the design system for the public pages. */

describe('public-page additions (D2)', () => {
  it('gives Status a green tone that still ships a text label', () => {
    const out = html(<Status kind="positive">Exclusivo ME/EPP</Status>)
    expect(out).toContain('Exclusivo ME/EPP')
    expect(out).toContain('bg-success-soft')
    expect(out).toContain('text-success')
  })

  it('sizes SectionLabel by prop, never by two competing font-size classes', () => {
    const board = html(<SectionLabel>Resumo</SectionLabel>)
    const publicPage = html(<SectionLabel size="caption">Resumo</SectionLabel>)
    expect(board).toContain('text-label')
    expect(board).not.toContain('text-caption')
    expect(publicPage).toContain('text-caption')
    expect(publicPage).not.toContain('text-label')
  })

  it('carries the graphite-panel tone for SectionLabel', () => {
    expect(html(<SectionLabel tone="inverse">Fundador</SectionLabel>)).toContain(
      'text-on-ink-faint',
    )
  })

  it('draws the three offer-page glyphs on the same grid as the rest', () => {
    for (const name of ['money', 'send', 'warning'] as const) {
      const out = html(<Icon name={name} />)
      expect(out).toContain('viewBox="0 0 24 24"')
      expect(out).toContain('stroke-width="1.8"')
      expect(out).toContain('<path')
    }
  })
})

/* What task D3 added to the design system for the Radar screens. */

describe('Select (D3)', () => {
  const UFS = [
    { value: '', label: 'Todo o Brasil' },
    { value: 'SP', label: 'São Paulo (SP)' },
  ]

  it('ties the label to a real <select>, never to a listbox of divs', () => {
    const out = html(<Select id="uf" label="UF onde você entrega" options={UFS} />)
    expect(out).toContain('<select')
    expect(out).toContain('for="uf"')
    expect(out).toContain('id="uf"')
    expect(out).toContain('<option value="SP">São Paulo (SP)</option>')
  })

  it('renders at 16px, like Field, so iOS Safari does not zoom on focus', () => {
    // F1 fixed this on `Field`; a 15px select beside a 16px input would zoom
    // the viewport the moment the user tapped the second control.
    expect(html(<Select id="uf" label="UF" options={UFS} />)).toContain('text-base')
  })

  it('marks an errored select invalid and points at both messages', () => {
    const out = html(
      <Select id="uf" label="UF" options={UFS} hint="Sigla" error="Escolha um estado" />,
    )
    expect(out).toContain('aria-invalid="true"')
    expect(out).toContain('aria-describedby="uf-error uf-hint"')
    expect(out).toContain('border-error')
  })

  it('omits aria-describedby when there is nothing to describe', () => {
    expect(html(<Select id="uf" label="UF" options={UFS} />)).not.toContain('aria-describedby')
  })
})

describe('Icon (D3)', () => {
  it('draws the app bar hamburger on the same grid as the rest', () => {
    const out = html(<Icon name="menu" />)
    expect(out).toContain('viewBox="0 0 24 24"')
    expect(out).toContain('stroke-width="1.8"')
    expect(out).toContain('M4 7h16M4 12h16M4 17h16')
  })
})

/**
 * The tab strip, now that both tender screens draw it.
 *
 * It lived inside `screening-view.tsx` and the Opportunity screen had none, so
 * the same tender had tabs after the AI reading and a loose block before it.
 * These tests pin the two shapes the product needs from one implementation.
 */
describe('Tabs', () => {
  const ITEMS: TabItem[] = [
    { id: 'items', label: 'Itens' },
    { id: 'files', label: 'Documentos' },
  ]

  it('renders a real <button role="tab"> per selectable item', () => {
    const out = html(<Tabs items={ITEMS} active="items" idPrefix="tender" />)
    expect(out.match(/role="tab"/g)).toHaveLength(2)
    expect(out).toContain('role="tablist"')
    expect(out).toContain('type="button"')
  })

  it('marks exactly one tab selected, and gives it the blue underline', () => {
    const out = html(<Tabs items={ITEMS} active="files" idPrefix="tender" />)
    expect(out.match(/aria-selected="true"/g)).toHaveLength(1)
    expect(out).toMatch(/aria-selected="true"[^>]*class="[^"]*border-blue/)
  })

  it('points each tab at the panel it controls, and back again', () => {
    const strip = html(<Tabs items={ITEMS} active="items" idPrefix="tender" />)
    const panel = html(
      <TabPanel idPrefix="tender" id="items">
        conteúdo
      </TabPanel>,
    )
    expect(strip).toContain(`id="${tabId('tender', 'items')}"`)
    expect(strip).toContain(`aria-controls="${panelId('tender', 'items')}"`)
    expect(panel).toContain(`id="${panelId('tender', 'items')}"`)
    expect(panel).toContain(`aria-labelledby="${tabId('tender', 'items')}"`)
    expect(panel).toContain('role="tabpanel"')
  })

  it('namespaces the ids, so two strips on one page cannot collide', () => {
    const a = html(<Tabs items={ITEMS} active="items" idPrefix="tender" />)
    const b = html(<Tabs items={ITEMS} active="items" idPrefix="screening" />)
    expect(a).toContain('tender-tab-items')
    expect(b).toContain('screening-tab-items')
    expect(a).not.toContain('screening-tab-items')
  })

  it('renders a locked item as a real link, never a disabled tab', () => {
    const out = html(
      <Tabs
        items={[{ id: 'summary', label: 'Resumo' }, { id: 'files', label: 'Documentos', href: '/conta/criar', icon: 'locked' }]}
        active="summary"
        idPrefix="screening"
      />,
    )
    expect(out).toContain('href="/conta/criar"')
    expect(out).not.toMatch(/\sdisabled(=|\s|>)/)
    // One tab, one link — the link is not counted as a selectable tab.
    expect(out.match(/role="tab"/g)).toHaveLength(1)
  })

  it('gives every stop the board’s 40px height', () => {
    const out = html(<Tabs items={ITEMS} active="items" idPrefix="tender" />)
    expect(out.match(/min-h-10/g)).toHaveLength(2)
  })
})
