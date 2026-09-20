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
  Tag,
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
    expect(out).toContain('Licita<span class="text-blue">Qui</span>')
  })

  it('scales the wordmark with the symbol, at the brand width axis', () => {
    expect(html(<Logo size={30} />)).toContain('font-size:22px')
    expect(html(<Logo size={60} />)).toContain('font-size:44px')
    expect(html(<Logo />)).toContain('font-stretch:85%')
  })

  it('never puts blue on blue: the ivory tone paints every bar ivory', () => {
    const out = html(<Logo tone="ivory" />)
    expect(out).not.toContain('fill-blue')
    expect(out.match(/fill-ivory/g)).toHaveLength(3)
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
