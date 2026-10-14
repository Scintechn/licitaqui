import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LoginSplitScreen } from './login-split-screen'
import { LoginBrandSide } from './login-brand-side'
import { LoginFormSide } from './login-form-side'

describe('LoginBrandSide', () => {
  it('renders the brand logo', () => {
    const out = renderToStaticMarkup(<LoginBrandSide />)
    expect(out).toContain('LicitaQui')
  })

  it('renders the brand tagline', () => {
    const out = renderToStaticMarkup(<LoginBrandSide />)
    expect(out).toContain('Encontre o edital que a sua empresa consegue atender')
  })

  it('renders the brand promise', () => {
    const out = renderToStaticMarkup(<LoginBrandSide />)
    expect(out).toContain('Para quem quer encontrar um edital')
  })

  it('uses brand-panel background color', () => {
    const out = renderToStaticMarkup(<LoginBrandSide />)
    expect(out).toContain('--color-brand-panel')
  })

  it('uses on-brand text color', () => {
    const out = renderToStaticMarkup(<LoginBrandSide />)
    expect(out).toContain('--color-on-brand')
  })

  it('applies hidden class for mobile responsiveness', () => {
    const out = renderToStaticMarkup(<LoginBrandSide />)
    expect(out).toContain('hidden')
  })

  it('applies lg:flex class for desktop display', () => {
    const out = renderToStaticMarkup(<LoginBrandSide />)
    expect(out).toContain('lg:flex')
  })

  it('is marked as aside for semantics', () => {
    const out = renderToStaticMarkup(<LoginBrandSide />)
    expect(out).toContain('<aside')
  })

  it('renders benefit bullet points', () => {
    const out = renderToStaticMarkup(<LoginBrandSide />)
    expect(out).toContain('Sem senha')
    expect(out).toContain('Grátis por sempre')
    expect(out).toContain('Pronto para usar')
  })
})

describe('LoginFormSide', () => {
  it('renders children content', () => {
    const out = renderToStaticMarkup(
      <LoginFormSide>
        <div>Test Form Content</div>
      </LoginFormSide>,
    )
    expect(out).toContain('Test Form Content')
  })

  it('uses ivory background color', () => {
    const out = renderToStaticMarkup(<LoginFormSide>Test</LoginFormSide>)
    expect(out).toContain('--color-ivory')
  })

  it('uses ink text color', () => {
    const out = renderToStaticMarkup(<LoginFormSide>Test</LoginFormSide>)
    expect(out).toContain('--color-ink')
  })

  it('is marked as main for semantics', () => {
    const out = renderToStaticMarkup(<LoginFormSide>Test</LoginFormSide>)
    expect(out).toContain('<main')
  })

  it('applies flex layout classes', () => {
    const out = renderToStaticMarkup(<LoginFormSide>Test</LoginFormSide>)
    expect(out).toContain('flex')
    expect(out).toContain('flex-col')
  })
})

describe('LoginSplitScreen', () => {
  const formContent = <div>Form Content</div>

  it('renders the brand side', () => {
    const out = renderToStaticMarkup(
      <LoginSplitScreen formContent={formContent} />,
    )
    expect(out).toContain('Encontre o edital')
  })

  it('renders the form content', () => {
    const out = renderToStaticMarkup(
      <LoginSplitScreen formContent={formContent} />,
    )
    expect(out).toContain('Form Content')
  })

  it('uses flex layout for responsive behavior', () => {
    const out = renderToStaticMarkup(
      <LoginSplitScreen formContent={formContent} />,
    )
    expect(out).toContain('flex')
  })

  it('applies flex-col-reverse for mobile layout', () => {
    const out = renderToStaticMarkup(
      <LoginSplitScreen formContent={formContent} />,
    )
    expect(out).toContain('flex-col-reverse')
  })

  it('applies lg:flex-row for desktop layout', () => {
    const out = renderToStaticMarkup(
      <LoginSplitScreen formContent={formContent} />,
    )
    expect(out).toContain('lg:flex-row')
  })

  it('sets min-h-dvh for full viewport height', () => {
    const out = renderToStaticMarkup(
      <LoginSplitScreen formContent={formContent} />,
    )
    expect(out).toContain('min-h-dvh')
  })

  it('renders both sides as equal flex-1 for 50/50 split on desktop', () => {
    const out = renderToStaticMarkup(
      <LoginSplitScreen formContent={formContent} />,
    )
    // Both sides should have flex-1 classes for equal width distribution
    const flex1Count = (out.match(/flex-1/g) || []).length
    expect(flex1Count).toBeGreaterThanOrEqual(2)
  })

  it('wraps form content in LoginFormSide', () => {
    const out = renderToStaticMarkup(
      <LoginSplitScreen formContent={<div className="test-form">TestForm</div>} />,
    )
    expect(out).toContain('test-form')
    expect(out).toContain('TestForm')
  })

  it('uses ivory background for the container', () => {
    const out = renderToStaticMarkup(
      <LoginSplitScreen formContent={formContent} />,
    )
    expect(out).toContain('--color-ivory')
  })
})

/**
 * Responsive behavior test.
 *
 * These tests verify that the layout CSS classes are correctly applied
 * for different screen sizes:
 *
 * - Mobile (<640px): flex-col-reverse (form on top, brand hidden via `hidden`)
 * - Tablet (640–1024px): flex-col-reverse (same as mobile)
 * - Desktop (1024px+): lg:flex-row (form on right, brand visible on left)
 *
 * The `hidden` and `lg:flex` classes ensure the brand side is invisible
 * on mobile/tablet and visible on desktop.
 */
describe('LoginSplitScreen responsive behavior', () => {
  it('hides brand side on mobile/tablet with hidden class', () => {
    const out = renderToStaticMarkup(
      <LoginSplitScreen formContent={<div>Form</div>} />,
    )
    // LoginBrandSide contains the hidden class for mobile responsiveness
    expect(out).toContain('hidden')
  })

  it('shows brand side on desktop with lg:flex class', () => {
    const out = renderToStaticMarkup(
      <LoginSplitScreen formContent={<div>Form</div>} />,
    )
    // LoginBrandSide contains lg:flex to show on desktop
    expect(out).toContain('lg:flex')
  })

  it('reverses flex direction on mobile (form first)', () => {
    const out = renderToStaticMarkup(
      <LoginSplitScreen formContent={<div>Form</div>} />,
    )
    // flex-col-reverse makes the form appear on top on mobile
    // when brand side is hidden
    expect(out).toContain('flex-col-reverse')
  })

  it('uses row direction on desktop for side-by-side layout', () => {
    const out = renderToStaticMarkup(
      <LoginSplitScreen formContent={<div>Form</div>} />,
    )
    expect(out).toContain('lg:flex-row')
  })

  it('allocates equal flex space to both sides on desktop', () => {
    const out = renderToStaticMarkup(
      <LoginSplitScreen formContent={<div>Form</div>} />,
    )
    // Both LoginBrandSide and LoginFormSide should have flex-1
    // for 50/50 split
    expect(out).toContain('flex-1')
  })
})
