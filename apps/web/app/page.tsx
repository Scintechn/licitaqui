import { Logo } from '@/components'

/**
 * Placeholder root. The real Landing is task D3 — this only proves the tokens,
 * the fonts and the logo component are wired into the app shell.
 */
export default function Home() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-gutter">
      <Logo size={44} />
      <p className="text-body text-muted">
        Encontre licitações públicas que a sua MEI ou ME consegue atender.
      </p>
    </main>
  )
}
