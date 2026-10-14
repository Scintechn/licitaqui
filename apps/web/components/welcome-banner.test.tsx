import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WelcomeBanner } from './welcome-banner'

describe('WelcomeBanner', () => {
  it('renders the provided message', () => {
    const message = 'Bem-vindo ao LicitaQui!'
    const out = renderToStaticMarkup(<WelcomeBanner message={message} />)
    expect(out).toContain(message)
  })

  it('includes a close button', () => {
    const out = renderToStaticMarkup(
      <WelcomeBanner message="Welcome" />,
    )
    expect(out).toContain('Fechar')
  })

  it('uses blue styling for the banner', () => {
    const out = renderToStaticMarkup(
      <WelcomeBanner message="Welcome" />,
    )
    expect(out).toContain('border-blue')
    expect(out).toContain('bg-blue')
  })

  it('has role=status and aria-live=polite for accessibility', () => {
    const out = renderToStaticMarkup(
      <WelcomeBanner message="Welcome" />,
    )
    expect(out).toContain('role="status"')
    expect(out).toContain('aria-live="polite"')
  })
})
