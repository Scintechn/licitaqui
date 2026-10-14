import Link from 'next/link'
import { Logo } from './logo'
import { messages } from '@/lib/messages'

export interface LoginBrandSideProps {
  /** Optional CSS class name for styling */
  className?: string
}

/**
 * Left side of the split-screen login layout.
 *
 * Displays the LicitaQui brand story, value proposition, and visual hierarchy
 * to orient new users about what the product does. Uses design tokens for
 * consistent styling with the rest of the product.
 *
 * Only visible on desktop (1024px+); on mobile and tablet, the form takes
 * the full width and this side is hidden via responsive classes.
 */
export function LoginBrandSide({ className = '' }: LoginBrandSideProps) {
  const brand = messages.brand

  return (
    <aside
      className={`hidden lg:flex flex-col items-start justify-center gap-6 px-gutter py-10 ${className}`}
      style={{
        backgroundColor: 'var(--color-brand-panel)',
        color: 'var(--color-on-brand)',
      }}
    >
      {/* Logo */}
      <Link href="/" aria-label={messages.radar.nav.home} className="inline-flex pl-24">
        <Logo size={40} tone="ivory" />
      </Link>

      {/* Value Proposition */}
      <div className="flex flex-col gap-4 px-24">
        <h2
          className="font-display text-2xl font-semibold leading-snug"
          style={{
            color: 'var(--color-on-brand)',
          }}
        >
          {brand.tagline}
        </h2>

        <p
          className="text-base leading-relaxed"
          style={{
            color: 'var(--color-on-brand-muted)',
          }}
        >
          {brand.promise}
        </p>
      </div>

      {/* Benefit Bullets (optional visual hierarchy) */}
      <div className="flex flex-col gap-3 pt-2 px-24">
        {[
          { title: 'Sem senha', desc: 'Entra com email ou Google' },
          { title: 'Grátis por sempre', desc: 'Cria sua conta em 30 segundos' },
          { title: 'Pronto para usar', desc: 'Veja seus editais na hora' },
        ].map((item) => (
          <div key={item.title} className="flex flex-col gap-1">
            <p
              className="text-sm font-semibold"
              style={{
                color: 'var(--color-on-brand)',
              }}
            >
              {item.title}
            </p>
            <p
              className="text-xs"
              style={{
                color: 'var(--color-on-brand-faint)',
              }}
            >
              {item.desc}
            </p>
          </div>
        ))}
      </div>
    </aside>
  )
}
